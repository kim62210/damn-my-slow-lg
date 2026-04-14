import { describe, it, expect } from 'vitest';
import { getDefaultConfig, validateConfig } from '../src/core/config';

describe('getDefaultConfig', () => {
  it('기본 설정을 올바르게 반환한다', () => {
    const config = getDefaultConfig();

    expect(config._config_version).toBe(1);
    expect(config.credentials.id).toBe('');
    expect(config.credentials.password).toBe('');
    expect(config.plan.speed_mbps).toBe(500);
    expect(config.schedule.time).toBe('04:00');
    expect(config.schedule.timezone).toBe('Asia/Seoul');
    expect(config.schedule.max_attempts).toBe(10);
    expect(config.schedule.retry_interval_minutes).toBe(120);
    expect(config.schedule.stop_on_complaint_success).toBe(true);
    expect(config.headless).toBe(true);
    expect(config.notification.discord_webhook).toBe('');
    expect(config.notification.telegram_bot_token).toBe('');
    expect(config.notification.telegram_chat_id).toBe('');
  });

  it('db_path가 lguplus를 포함한다', () => {
    const config = getDefaultConfig();
    expect(config.db_path).toContain('lguplus');
  });
});

describe('validateConfig', () => {
  it('기본 설정(빈 값)은 credentials 에러를 반환한다', () => {
    const config = getDefaultConfig();
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some(e => e.includes('credentials.id'))).toBe(true);
    expect(errors.some(e => e.includes('credentials.password'))).toBe(true);
  });

  it('모든 필수 필드가 채워지면 에러가 없다', () => {
    const config = getDefaultConfig();
    config.credentials.id = 'testuser';
    config.credentials.password = 'testpass';
    config.plan.speed_mbps = 500;
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('speed_mbps가 0이면 에러를 반환한다', () => {
    const config = getDefaultConfig();
    config.credentials.id = 'testuser';
    config.credentials.password = 'testpass';
    config.plan.speed_mbps = 0;
    const errors = validateConfig(config);
    expect(errors.some(e => e.includes('plan.speed_mbps'))).toBe(true);
  });
});
