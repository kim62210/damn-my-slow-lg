/**
 * Discord / Telegram 알림 모듈
 */

import axios from 'axios';
import type { Notification, NotifyPayload } from '../types';

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

export async function sendTelegram(
  botToken: string,
  chatId: string,
  payload: NotifyPayload,
): Promise<void> {
  if (!botToken || !chatId) return;

  // Telegram은 bold에 * 사용 (Markdown)
  const text = formatMessage(payload).replace(/\*\*/g, '*');

  await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
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
