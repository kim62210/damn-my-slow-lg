/**
 * 설정 파일 로드/저장 - LG U+ 전용
 * 기본 경로: ~/.damn-my-slow-isp/config-lguplus.yaml
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import os from 'os';
import type { Config } from '../types';

/** 모든 ISP 공용 데이터 디렉토리 (~/.damn-my-slow-isp/) */
export const DATA_DIR = path.join(os.homedir(), '.damn-my-slow-isp');
const CONFIG_FILE = 'config-lguplus.yaml';
const CURRENT_CONFIG_VERSION = 1;

export function getConfigPath(): string {
  return path.join(DATA_DIR, CONFIG_FILE);
}

export function getDefaultConfig(): Config {
  return {
    _config_version: CURRENT_CONFIG_VERSION,
    credentials: { id: '', password: '' },
    phone: '',
    plan: { speed_mbps: 500 },
    schedule: {
      time: '04:00',
      timezone: 'Asia/Seoul',
      max_attempts: 10,
      retry_interval_minutes: 120,
      stop_on_complaint_success: true,
    },
    notification: {
      discord_webhook: '',
      telegram_bot_token: '',
      telegram_chat_id: '',
    },
    headless: true,
    db_path: path.join(DATA_DIR, 'history-lguplus.db'),
  };
}

export function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } else {
    fs.chmodSync(DATA_DIR, 0o700);
  }
}

export function loadConfig(customPath?: string): Config {
  const configPath = customPath || getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `설정 파일이 없습니다: ${configPath}\n` +
      '`damn-my-slow-lg init` 명령으로 초기 설정을 진행해주세요.'
    );
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as Partial<Config>;
  const defaults = getDefaultConfig();

  const config: Config = {
    ...defaults,
    ...parsed,
    credentials: { ...defaults.credentials, ...parsed.credentials },
    plan: { ...defaults.plan, ...parsed.plan },
    schedule: { ...defaults.schedule, ...parsed.schedule },
    notification: { ...defaults.notification, ...parsed.notification },
  };

  // 환경변수 오버라이드 (config 파일보다 우선)
  if (process.env.DMSL_LG_ID) {
    config.credentials.id = process.env.DMSL_LG_ID;
  }
  if (process.env.DMSL_LG_PASSWORD) {
    config.credentials.password = process.env.DMSL_LG_PASSWORD;
  }
  if (process.env.DMSL_DISCORD_WEBHOOK) {
    config.notification.discord_webhook = process.env.DMSL_DISCORD_WEBHOOK;
  }
  if (process.env.DMSL_TELEGRAM_TOKEN) {
    config.notification.telegram_bot_token = process.env.DMSL_TELEGRAM_TOKEN;
  }
  if (process.env.DMSL_TELEGRAM_CHAT) {
    config.notification.telegram_chat_id = process.env.DMSL_TELEGRAM_CHAT;
  }

  return config;
}

export function saveConfig(config: Config): void {
  ensureDataDir();
  const configPath = getConfigPath();
  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });
  fs.writeFileSync(configPath, content, { encoding: 'utf-8', mode: 0o600 });
}

export function configExists(customPath?: string): boolean {
  return fs.existsSync(customPath || getConfigPath());
}

/** 설정 필수 필드 검증. 비어있거나 0인 필수 필드에 대해 에러 메시지 배열 반환 */
export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  if (!config.credentials.id) {
    errors.push('credentials.id (LG U+ 아이디)가 비어 있습니다.');
  }
  if (!config.credentials.password) {
    errors.push('credentials.password (LG U+ 비밀번호)가 비어 있습니다.');
  }
  if (!config.plan.speed_mbps || config.plan.speed_mbps <= 0) {
    errors.push('plan.speed_mbps (계약 속도)가 설정되지 않았습니다.');
  }
  return errors;
}
