import { describe, it, expect } from 'vitest';
import { getMinGuaranteedSpeed, judgeRound, judgeSLA, summarizeSLA } from '../src/core/sla';
import type { SpeedTestRound } from '../src/types';

describe('getMinGuaranteedSpeed', () => {
  it('계약속도의 50%를 반환한다', () => {
    expect(getMinGuaranteedSpeed(100)).toBe(50);
    expect(getMinGuaranteedSpeed(500)).toBe(250);
    expect(getMinGuaranteedSpeed(1000)).toBe(500);
    expect(getMinGuaranteedSpeed(10000)).toBe(5000);
  });
});

describe('judgeRound', () => {
  it('최저보장속도 이상이면 true', () => {
    expect(judgeRound(300, 250)).toBe(true);
    expect(judgeRound(250, 250)).toBe(true);
  });

  it('최저보장속도 미만이면 false', () => {
    expect(judgeRound(249.9, 250)).toBe(false);
    expect(judgeRound(0, 250)).toBe(false);
  });
});

describe('judgeSLA', () => {
  it('빈 배열이면 unknown', () => {
    expect(judgeSLA([])).toBe('unknown');
  });

  it('5회 중 3회 미달이면 fail', () => {
    const rounds: SpeedTestRound[] = [
      { round: 1, download_mbps: 200, upload_mbps: 100, passed: false },
      { round: 2, download_mbps: 300, upload_mbps: 100, passed: true },
      { round: 3, download_mbps: 100, upload_mbps: 100, passed: false },
      { round: 4, download_mbps: 150, upload_mbps: 100, passed: false },
      { round: 5, download_mbps: 400, upload_mbps: 100, passed: true },
    ];
    expect(judgeSLA(rounds)).toBe('fail');
  });

  it('5회 중 2회 미달이면 pass', () => {
    const rounds: SpeedTestRound[] = [
      { round: 1, download_mbps: 200, upload_mbps: 100, passed: false },
      { round: 2, download_mbps: 300, upload_mbps: 100, passed: true },
      { round: 3, download_mbps: 300, upload_mbps: 100, passed: true },
      { round: 4, download_mbps: 150, upload_mbps: 100, passed: false },
      { round: 5, download_mbps: 400, upload_mbps: 100, passed: true },
    ];
    expect(judgeSLA(rounds)).toBe('pass');
  });

  it('5회 중 5회 전부 미달이면 fail', () => {
    const rounds: SpeedTestRound[] = Array.from({ length: 5 }, (_, i) => ({
      round: i + 1,
      download_mbps: 100,
      upload_mbps: 50,
      passed: false,
    }));
    expect(judgeSLA(rounds)).toBe('fail');
  });

  it('5회 전부 통과면 pass', () => {
    const rounds: SpeedTestRound[] = Array.from({ length: 5 }, (_, i) => ({
      round: i + 1,
      download_mbps: 500,
      upload_mbps: 200,
      passed: true,
    }));
    expect(judgeSLA(rounds)).toBe('pass');
  });

  it('3회 측정 중 2회 미달이면 fail (60% 기준)', () => {
    const rounds: SpeedTestRound[] = [
      { round: 1, download_mbps: 100, upload_mbps: 50, passed: false },
      { round: 2, download_mbps: 100, upload_mbps: 50, passed: false },
      { round: 3, download_mbps: 500, upload_mbps: 200, passed: true },
    ];
    expect(judgeSLA(rounds)).toBe('fail');
  });
});

describe('summarizeSLA', () => {
  it('라운드별 요약을 올바르게 반환한다', () => {
    const rounds: SpeedTestRound[] = [
      { round: 1, download_mbps: 200, upload_mbps: 100, passed: false },
      { round: 2, download_mbps: 300, upload_mbps: 100, passed: true },
      { round: 3, download_mbps: 100, upload_mbps: 100, passed: false },
      { round: 4, download_mbps: 150, upload_mbps: 100, passed: false },
      { round: 5, download_mbps: 400, upload_mbps: 100, passed: true },
    ];

    const summary = summarizeSLA(rounds, 500);
    expect(summary.total).toBe(5);
    expect(summary.satisfy).toBe(2);
    expect(summary.fail).toBe(3);
    expect(summary.sla_result).toBe('fail');
    expect(summary.min_guaranteed_mbps).toBe(250);
  });
});
