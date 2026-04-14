/**
 * SLA 판정 로직
 *
 * 방통위 고시 기준:
 * - 30분 동안 5회 측정
 * - 60% 이상 (3회 이상)이 최저보장속도 미달 시 당일 요금 감면
 * - 최저보장속도 = 계약속도의 50%
 */

import type { SpeedTestRound } from '../types';

/** 최저보장속도 계산 (계약속도의 50%) */
export function getMinGuaranteedSpeed(planSpeedMbps: number): number {
  return planSpeedMbps * 0.5;
}

/** 개별 라운드의 합격/불합격 판정 */
export function judgeRound(downloadMbps: number, minGuaranteedMbps: number): boolean {
  return downloadMbps >= minGuaranteedMbps;
}

/** 전체 SLA 판정 (5회 중 3회 이상 미달 시 fail) */
export function judgeSLA(rounds: SpeedTestRound[]): 'pass' | 'fail' | 'unknown' {
  if (rounds.length === 0) return 'unknown';

  const total = rounds.length;
  const failCount = rounds.filter(r => !r.passed).length;

  // 60% 이상 미달 시 fail (5회 기준 3회)
  const failThreshold = Math.ceil(total * 0.6);
  if (failCount >= failThreshold) return 'fail';

  return 'pass';
}

/** SLA 판정 결과 요약 생성 */
export function summarizeSLA(
  rounds: SpeedTestRound[],
  planSpeedMbps: number,
): {
  total: number;
  satisfy: number;
  fail: number;
  sla_result: 'pass' | 'fail' | 'unknown';
  min_guaranteed_mbps: number;
} {
  const total = rounds.length;
  const fail = rounds.filter(r => !r.passed).length;
  const satisfy = total - fail;

  return {
    total,
    satisfy,
    fail,
    sla_result: judgeSLA(rounds),
    min_guaranteed_mbps: getMinGuaranteedSpeed(planSpeedMbps),
  };
}
