import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Schedule } from '../src/types';

// child_process를 vi.mock으로 모듈 레벨에서 mock (호이스팅 됨)
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// fs도 동일하게 mock
const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const originalFs = await vi.importActual<typeof import('fs')>('fs');
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    },
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  };
});

import { installCrontab } from '../src/core/scheduler';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    time: '04:00',
    timezone: 'Asia/Seoul',
    max_attempts: 10,
    retry_interval_minutes: 120,
    stop_on_complaint_success: true,
    ...overrides,
  };
}

describe('installCrontab', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('기존 블록 내부의 cron 라인까지 모두 제거하고 새로 설치한다', () => {
    const existingCrontab = [
      '0 3 * * * /usr/bin/backup',
      '# damn-my-slow-lg',
      '0 4 * * * /usr/bin/node old-entry run >> /tmp/log 2>&1',
      '0 6 * * * /usr/bin/node old-entry run >> /tmp/log 2>&1',
      '# /damn-my-slow-lg',
      '30 12 * * 1 /usr/bin/weekly-task',
    ].join('\n');

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('crontab -l')) return existingCrontab;
      return '';
    });

    const schedule = makeSchedule({
      time: '08:00',
      retry_interval_minutes: 120,
      max_attempts: 2,
    });

    installCrontab(schedule);

    // writeFileSync가 호출되었는지 확인
    expect(mockWriteFileSync).toHaveBeenCalled();
    const writtenContent = String(mockWriteFileSync.mock.calls[0][1]);

    // 이전 블록의 old-entry가 남아있으면 안 된다
    expect(writtenContent).not.toContain('old-entry');
    // 기존의 다른 cron 항목은 보존되어야 한다
    expect(writtenContent).toContain('/usr/bin/backup');
    expect(writtenContent).toContain('/usr/bin/weekly-task');
    // 새 블록이 설치되어야 한다
    expect(writtenContent).toContain('# damn-my-slow-lg');
    expect(writtenContent).toContain('# /damn-my-slow-lg');
    expect(writtenContent).toContain('8 * * *');
    expect(writtenContent).toContain('10 * * *');
  });
});
