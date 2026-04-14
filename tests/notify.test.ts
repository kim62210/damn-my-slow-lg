import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NotifyPayload, SpeedTestResult } from '../src/types';

// axios mock
vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ status: 200 }),
  },
}));

import { sendDiscord, sendTelegram, notify, shouldThrottleNotify, needsRecoveryNotify } from '../src/core/notify';
import axios from 'axios';

const mockResult: SpeedTestResult = {
  download_mbps: 200.5,
  upload_mbps: 100.2,
  ping_ms: 5,
  sla_result: 'fail',
  complaint_filed: false,
  complaint_result: 'skipped',
  raw_data: {
    total: 5,
    satisfy: 2,
    fail: 3,
    rounds: [
      { round: 1, download_mbps: 200, upload_mbps: 100, passed: false },
      { round: 2, download_mbps: 300, upload_mbps: 100, passed: true },
      { round: 3, download_mbps: 100, upload_mbps: 50, passed: false },
      { round: 4, download_mbps: 150, upload_mbps: 80, passed: false },
      { round: 5, download_mbps: 280, upload_mbps: 120, passed: true },
    ],
  },
  error: '',
};

const mockPayload: NotifyPayload = {
  title: 'LG U+ 속도 측정 결과',
  result: mockResult,
  plan_speed: 500,
  min_guaranteed_speed: 250,
  timestamp: '2026-04-14 10:00:00',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendDiscord', () => {
  it('webhook URL이 있으면 POST 요청을 보낸다', async () => {
    await sendDiscord('https://discord.com/api/webhooks/test', mockPayload);
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [url, body] = (axios.post as any).mock.calls[0];
    expect(url).toBe('https://discord.com/api/webhooks/test');
    expect(body.embeds[0].title).toBe('damn-my-slow-lg');
    expect(body.embeds[0].color).toBe(0xff0000); // fail = red
  });

  it('webhook URL이 비어있으면 요청하지 않는다', async () => {
    await sendDiscord('', mockPayload);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('sendTelegram', () => {
  it('bot token과 chat id가 있으면 POST 요청을 보낸다', async () => {
    await sendTelegram('bot123', 'chat456', mockPayload);
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [url] = (axios.post as any).mock.calls[0];
    expect(url).toContain('api.telegram.org/botbot123/sendMessage');
  });

  it('HTML parse_mode로 전송하고 bold 태그를 사용한다', async () => {
    await sendTelegram('bot123', 'chat456', mockPayload);

    const [, body] = (axios.post as any).mock.calls[0];
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('<b>');
    expect(body.text).toContain('</b>');
    // **마커가 남아있지 않아야 한다
    expect(body.text).not.toContain('**');
  });

  it('HTML 특수문자가 이스케이프된다', async () => {
    const payloadWithSpecialChars: NotifyPayload = {
      ...mockPayload,
      result: { ...mockResult, error: 'timeout < 5s & retry > 3' },
    };
    await sendTelegram('bot123', 'chat456', payloadWithSpecialChars);

    const [, body] = (axios.post as any).mock.calls[0];
    expect(body.text).toContain('&lt;');
    expect(body.text).toContain('&gt;');
    expect(body.text).toContain('&amp;');
  });

  it('bot token이 비어있으면 요청하지 않는다', async () => {
    await sendTelegram('', 'chat456', mockPayload);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('notify', () => {
  it('Discord와 Telegram 모두 설정되어 있으면 둘 다 호출한다', async () => {
    await notify(
      {
        discord_webhook: 'https://discord.com/api/webhooks/test',
        telegram_bot_token: 'bot123',
        telegram_chat_id: 'chat456',
      },
      mockPayload,
    );
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('아무것도 설정되지 않으면 호출하지 않는다', async () => {
    await notify(
      { discord_webhook: '', telegram_bot_token: '', telegram_chat_id: '' },
      mockPayload,
    );
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('shouldThrottleNotify', () => {
  const STATE_FILE = path.join(os.homedir(), '.damn-my-slow-isp', 'notify-state.json');
  let stateBackup: string | null = null;

  beforeEach(() => {
    // 기존 상태 파일 백업
    try {
      stateBackup = fs.readFileSync(STATE_FILE, 'utf-8');
    } catch {
      stateBackup = null;
    }
    // 테스트용 초기화
    try { fs.unlinkSync(STATE_FILE); } catch { /* 없으면 무시 */ }
  });

  afterEach(() => {
    // 상태 파일 복원
    if (stateBackup !== null) {
      fs.writeFileSync(STATE_FILE, stateBackup, 'utf-8');
    } else {
      try { fs.unlinkSync(STATE_FILE); } catch { /* 없으면 무시 */ }
    }
  });

  const makeErrorResult = (error = '측정 프로그램 미설치'): SpeedTestResult => ({
    ...mockResult,
    sla_result: 'unknown',
    error,
  });

  const makePassResult = (): SpeedTestResult => ({
    ...mockResult,
    sla_result: 'pass',
    error: '',
  });

  it('정상 결과는 throttle하지 않는다', () => {
    expect(shouldThrottleNotify(makePassResult())).toBe(false);
  });

  it('첫 에러는 throttle하지 않는다', () => {
    expect(shouldThrottleNotify(makeErrorResult())).toBe(false);
  });

  it('동일 에러 2회까지는 throttle하지 않는다', () => {
    shouldThrottleNotify(makeErrorResult());
    expect(shouldThrottleNotify(makeErrorResult())).toBe(false);
  });

  it('동일 에러 3회째부터 throttle한다', () => {
    shouldThrottleNotify(makeErrorResult());
    shouldThrottleNotify(makeErrorResult());
    shouldThrottleNotify(makeErrorResult()); // 3회째: 알림 허용 (첫 throttle 시점)
    // 4회째: 24시간 안 지남 -> throttle
    expect(shouldThrottleNotify(makeErrorResult())).toBe(true);
  });

  it('다른 에러가 발생하면 카운트가 리셋된다', () => {
    shouldThrottleNotify(makeErrorResult('에러 A'));
    shouldThrottleNotify(makeErrorResult('에러 A'));
    shouldThrottleNotify(makeErrorResult('에러 A'));
    // 다른 에러 -> 리셋
    expect(shouldThrottleNotify(makeErrorResult('에러 B'))).toBe(false);
  });

  it('에러 후 정상 결과가 오면 상태가 초기화된다', () => {
    shouldThrottleNotify(makeErrorResult());
    shouldThrottleNotify(makeErrorResult());
    shouldThrottleNotify(makeErrorResult());
    // 정상 -> 초기화
    shouldThrottleNotify(makePassResult());
    // 다시 에러 -> 첫 에러로 취급
    expect(shouldThrottleNotify(makeErrorResult())).toBe(false);
  });
});

describe('needsRecoveryNotify', () => {
  const STATE_FILE = path.join(os.homedir(), '.damn-my-slow-isp', 'notify-state.json');
  let stateBackup: string | null = null;

  beforeEach(() => {
    try {
      stateBackup = fs.readFileSync(STATE_FILE, 'utf-8');
    } catch {
      stateBackup = null;
    }
    try { fs.unlinkSync(STATE_FILE); } catch { /* 없으면 무시 */ }
  });

  afterEach(() => {
    if (stateBackup !== null) {
      fs.writeFileSync(STATE_FILE, stateBackup, 'utf-8');
    } else {
      try { fs.unlinkSync(STATE_FILE); } catch { /* 없으면 무시 */ }
    }
  });

  it('연속 에러 3회 이상 후 복구 알림 필요', () => {
    const errorResult: SpeedTestResult = { ...mockResult, sla_result: 'unknown', error: 'test error' };
    shouldThrottleNotify(errorResult);
    shouldThrottleNotify(errorResult);
    shouldThrottleNotify(errorResult);
    expect(needsRecoveryNotify()).toBe(true);
  });

  it('에러 이력 없으면 복구 알림 불필요', () => {
    expect(needsRecoveryNotify()).toBe(false);
  });
});
