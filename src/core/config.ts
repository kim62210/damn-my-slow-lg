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
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `설정 파일이 없습니다: ${configPath}\n` +
      '`damn-my-dumb-lg init` 명령으로 초기 설정을 진행해주세요.'
    );
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(raw) as Partial<Config>;
  const defaults = getDefaultConfig();

  return {
    ...defaults,
    ...parsed,
    credentials: { ...defaults.credentials, ...parsed.credentials },
    plan: { ...defaults.plan, ...parsed.plan },
    schedule: { ...defaults.schedule, ...parsed.schedule },
    notification: { ...defaults.notification, ...parsed.notification },
  };
}

export function saveConfig(config: Config): void {
  ensureDataDir();
  const configPath = getConfigPath();
  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });
  fs.writeFileSync(configPath, content, 'utf-8');
}

export function configExists(): boolean {
  return fs.existsSync(getConfigPath());
}
