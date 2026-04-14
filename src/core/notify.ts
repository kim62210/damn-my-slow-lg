/**
 * Discord / Telegram 알림 모듈
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Notification, NotifyPayload, SpeedTestResult } from '../types';

/** 알림 throttle 상태 */
interface NotifyState {
  lastError: string;
  consecutiveErrors: number;
  lastNotifiedAt: string;
}

const STATE_DIR = path.join(os.homedir(), '.damn-my-slow-isp');
const STATE_FILE = path.join(STATE_DIR, 'notify-state.json');

function loadNotifyState(): NotifyState | null {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as NotifyState;
    }
  } catch {
    // 파싱 실패 시 초기 상태로
  }
  return null;
}

function saveNotifyState(state: NotifyState): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 연속 에러 시 알림 throttle 판정.
 * - sla_result === 'unknown' && error 있을 때만 throttle 대상
 * - 동일 에러 3회 이상 연속이면 하루 1회만 알림
 * - 에러 -> 성공 전환 시 false 반환 (복구 알림 발송용)
 */
export function shouldThrottleNotify(result: SpeedTestResult): boolean {
  const isError = result.sla_result === 'unknown' && !!result.error;
  const prev = loadNotifyState();

  if (!isError) {
    // 정상 결과 - throttle 안 함, 상태 초기화
    if (prev && prev.consecutiveErrors > 0) {
      saveNotifyState({ lastError: '', consecutiveErrors: 0, lastNotifiedAt: '' });
    }
    return false;
  }

  // 에러인 경우
  const errorKey = result.error;
  const now = new Date();

  if (!prev || prev.lastError !== errorKey) {
    // 새로운 에러 - 카운트 리셋, 알림 허용
    saveNotifyState({ lastError: errorKey, consecutiveErrors: 1, lastNotifiedAt: now.toISOString() });
    return false;
  }

  // 동일 에러 반복
  const newCount = prev.consecutiveErrors + 1;

  if (newCount < 3) {
    // 3회 미만이면 알림 허용
    saveNotifyState({ lastError: errorKey, consecutiveErrors: newCount, lastNotifiedAt: now.toISOString() });
    return false;
  }

  // 3회 이상: 마지막 알림으로부터 24시간 경과했는지 확인
  if (prev.lastNotifiedAt) {
    const lastNotified = new Date(prev.lastNotifiedAt);
    const hoursSince = (now.getTime() - lastNotified.getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      // 24시간 안 지남 - throttle
      saveNotifyState({ lastError: errorKey, consecutiveErrors: newCount, lastNotifiedAt: prev.lastNotifiedAt });
      return true;
    }
  }

  // 24시간 경과 또는 첫 알림 - 허용
  saveNotifyState({ lastError: errorKey, consecutiveErrors: newCount, lastNotifiedAt: now.toISOString() });
  return false;
}

/**
 * 에러 -> 성공 전환 시 복구 알림이 필요한지 반환.
 */
export function needsRecoveryNotify(): boolean {
  const prev = loadNotifyState();
  return prev !== null && prev.consecutiveErrors >= 3;
}

const TIMEOUT_MS = 10_000;

function formatMessage(payload: NotifyPayload): string {
  const { result, plan_speed, min_guaranteed_speed, timestamp } = payload;
  const slaEmoji = result.sla_result === 'pass' ? '✅' : result.sla_result === 'fail' ? '❌' : '❓';
  const complaintText =
    result.complaint_result === 'success' ? '✅ 감면 신청 완료'
    : result.complaint_result === 'failed' ? '❌ 감면 신청 실패'
    : result.complaint_result === 'skipped' ? '⏭️ 감면 신청 스킵'
    : '—';

  const lines = [
    `📊 **LG U+ 속도 측정 결과**`,
    ``,
    `⏰ ${timestamp}`,
    `📥 다운로드: **${result.download_mbps.toFixed(1)} Mbps**`,
    `📤 업로드: **${result.upload_mbps.toFixed(1)} Mbps**`,
    `📶 핑: **${result.ping_ms.toFixed(0)} ms**`,
    ``,
    `📋 계약 속도: ${plan_speed} Mbps`,
    `📋 최저보장: ${min_guaranteed_speed} Mbps (50%)`,
    ``,
    `${slaEmoji} SLA 판정: **${result.sla_result.toUpperCase()}**`,
  ];

  if (result.raw_data.rounds.length > 0) {
    lines.push(`   (${result.raw_data.total}회 중 ${result.raw_data.fail}회 미달)`);
  }

  lines.push(`🗂️ 감면 신청: ${complaintText}`);

  if (result.error) {
    lines.push(``, `⚠️ 오류: ${result.error}`);
  }

  return lines.join('\n');
}

export async function sendDiscord(webhook: string, payload: NotifyPayload): Promise<void> {
  if (!webhook) return;

  const color = payload.result.sla_result === 'pass' ? 0x00ff00
    : payload.result.sla_result === 'fail' ? 0xff0000
    : 0xffaa00;

  await axios.post(webhook, {
    embeds: [{
      title: 'damn-my-slow-lg',
      description: formatMessage(payload),
      color,
      timestamp: new Date().toISOString(),
    }],
  }, { timeout: TIMEOUT_MS });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTelegramHtml(payload: NotifyPayload): string {
  const raw = formatMessage(payload);
  // 먼저 HTML 특수문자 이스케이프 (bold 마커 제외 영역)
  // **텍스트** -> <b>텍스트</b> 변환
  const escaped = escapeHtml(raw.replace(/\*\*/g, '\x00'));
  return escaped.replace(/\x00([^\x00]+)\x00/g, '<b>$1</b>');
}

export async function sendTelegram(
  botToken: string,
  chatId: string,
  payload: NotifyPayload,
): Promise<void> {
  if (!botToken || !chatId) return;

  const text = formatTelegramHtml(payload);

  await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    },
    { timeout: TIMEOUT_MS },
  );
}

export async function notify(config: Notification, payload: NotifyPayload): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (config.discord_webhook) {
    tasks.push(
      sendDiscord(config.discord_webhook, payload).catch(err => {
        console.error(`Discord 알림 실패: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  }

  if (config.telegram_bot_token && config.telegram_chat_id) {
    tasks.push(
      sendTelegram(config.telegram_bot_token, config.telegram_chat_id, payload).catch(err => {
        console.error(`Telegram 알림 실패: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  }

  await Promise.all(tasks);
}
