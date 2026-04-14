import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotifyPayload, SpeedTestResult } from '../src/types';

// axios mock
vi.mock('axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ status: 200 }),
  },
}));

import { sendDiscord, sendTelegram, notify } from '../src/core/notify';
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
