import { describe, it, expect } from 'vitest';
import { buildScheduleEntries } from '../src/core/scheduler';
import type { Schedule } from '../src/types';

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

describe('buildScheduleEntries', () => {
  it('04:00 시작, 120분 간격, 10회 -> 04:00~22:00 2시간 간격', () => {
    const schedule = makeSchedule({
      time: '04:00',
      retry_interval_minutes: 120,
      max_attempts: 10,
    });

    const entries = buildScheduleEntries(schedule);
    expect(entries).toHaveLength(10);

    const expected = [
      { Hour: 4, Minute: 0 },
      { Hour: 6, Minute: 0 },
      { Hour: 8, Minute: 0 },
      { Hour: 10, Minute: 0 },
      { Hour: 12, Minute: 0 },
      { Hour: 14, Minute: 0 },
      { Hour: 16, Minute: 0 },
      { Hour: 18, Minute: 0 },
      { Hour: 20, Minute: 0 },
      { Hour: 22, Minute: 0 },
    ];
    expect(entries).toEqual(expected);
  });

  it('23:00 시작, 60분 간격, 3회 -> 자정을 넘긴다', () => {
    const schedule = makeSchedule({
      time: '23:00',
      retry_interval_minutes: 60,
      max_attempts: 3,
    });

    const entries = buildScheduleEntries(schedule);
    expect(entries).toHaveLength(3);
    expect(entries).toEqual([
      { Hour: 23, Minute: 0 },
      { Hour: 0, Minute: 0 },
      { Hour: 1, Minute: 0 },
    ]);
  });

  it('00:00 시작, 30분 간격, 5회', () => {
    const schedule = makeSchedule({
      time: '00:00',
      retry_interval_minutes: 30,
      max_attempts: 5,
    });

    const entries = buildScheduleEntries(schedule);
    expect(entries).toHaveLength(5);
    expect(entries).toEqual([
      { Hour: 0, Minute: 0 },
      { Hour: 0, Minute: 30 },
      { Hour: 1, Minute: 0 },
      { Hour: 1, Minute: 30 },
      { Hour: 2, Minute: 0 },
    ]);
  });

  it('1회만 설정하면 시작 시각만 반환한다', () => {
    const schedule = makeSchedule({
      time: '09:30',
      retry_interval_minutes: 60,
      max_attempts: 1,
    });

    const entries = buildScheduleEntries(schedule);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ Hour: 9, Minute: 30 });
  });

  it('분 단위 오프셋이 있는 시작 시각 (04:15, 45분 간격, 4회)', () => {
    const schedule = makeSchedule({
      time: '04:15',
      retry_interval_minutes: 45,
      max_attempts: 4,
    });

    const entries = buildScheduleEntries(schedule);
    expect(entries).toHaveLength(4);
    expect(entries).toEqual([
      { Hour: 4, Minute: 15 },
      { Hour: 5, Minute: 0 },
      { Hour: 5, Minute: 45 },
      { Hour: 6, Minute: 30 },
    ]);
  });
});

