/**
 * Ookla Speedtest CLI Provider
 *
 * LGU+ 공식 속도측정 페이지 접근 불가 시 fallback 측정 수단.
 * `speedtest --format=json` 으로 5회 반복 측정 후 SLA 판정.
 *
 * 주의: Ookla 측정은 LGU+ 공식 측정이 아니므로 SLA 감면 증빙으로 사용 불가.
 * 결과는 참고용이며 complaint_result는 항상 'not_applicable'.
 */

import { execFileSync, execSync } from 'child_process';
import type { Config, SpeedTestResult, SpeedTestRound } from '../types';
import { getMinGuaranteedSpeed, judgeRound, judgeSLA } from '../core/sla';

/** Ookla Speedtest CLI JSON 응답 구조 */
interface SpeedtestCliOutput {
  download: { bandwidth: number; bytes: number; elapsed: number };
  upload: { bandwidth: number; bytes: number; elapsed: number };
  ping: { jitter: number; latency: number };
  server: { id: number; name: string; host: string };
  result: { url: string };
}

/** 측정 간 대기 시간 (ms) */
const ROUND_INTERVAL_MS = 30_000;
/** 총 측정 횟수 */
const TOTAL_ROUNDS = 5;
/** CLI 실행 타임아웃 (ms) - 1회 측정에 최대 2분 */
const CLI_TIMEOUT_MS = 120_000;

/** bytes/second -> Mbps 변환 */
function bandwidthToMbps(bandwidthBytesPerSec: number): number {
  return (bandwidthBytesPerSec * 8) / 1_000_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SpeedtestCliProvider {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /** speedtest CLI 설치 여부 확인 */
  static isAvailable(): boolean {
    try {
      const cmd = process.platform === 'win32' ? 'where speedtest' : 'which speedtest';
      execSync(cmd, { stdio: 'ignore', timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** speedtest CLI 1회 실행 후 JSON 파싱 */
  private runOnce(): SpeedtestCliOutput {
    const stdout = execFileSync('speedtest', [
      '--format=json',
      '--accept-license',
      '--accept-gdpr',
    ], {
      encoding: 'utf-8',
      timeout: CLI_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return JSON.parse(stdout) as SpeedtestCliOutput;
  }

  /** 5회 반복 측정 + SLA 판정 */
  async run(dryRun = false): Promise<SpeedTestResult> {
    if (!SpeedtestCliProvider.isAvailable()) {
      const installHint = process.platform === 'darwin'
        ? 'brew install speedtest-cli'
        : process.platform === 'win32'
          ? 'https://www.speedtest.net/apps/cli (Windows installer)'
          : 'sudo apt-get install speedtest-cli  # 또는 https://www.speedtest.net/apps/cli';

      return {
        download_mbps: 0,
        upload_mbps: 0,
        ping_ms: 0,
        sla_result: 'unknown',
        complaint_filed: false,
        complaint_result: 'not_applicable',
        raw_data: { total: 0, satisfy: 0, fail: 0, rounds: [] },
        error: `speedtest CLI가 설치되어 있지 않습니다. 설치: ${installHint}`,
      };
    }

    const minSpeed = getMinGuaranteedSpeed(this.config.plan.speed_mbps);
    const rounds: SpeedTestRound[] = [];
    let lastPingMs = 0;
    const errors: string[] = [];

    for (let i = 1; i <= TOTAL_ROUNDS; i++) {
      if (i > 1) {
        console.log(`[Speedtest CLI] 다음 측정까지 30초 대기...`);
        await sleep(ROUND_INTERVAL_MS);
      }

      console.log(`[Speedtest CLI] ${i}/${TOTAL_ROUNDS}회 측정 중...`);

      try {
        const output = this.runOnce();
        const downloadMbps = bandwidthToMbps(output.download.bandwidth);
        const uploadMbps = bandwidthToMbps(output.upload.bandwidth);
        lastPingMs = output.ping.latency;

        const passed = judgeRound(downloadMbps, minSpeed);
        rounds.push({
          round: i,
          download_mbps: downloadMbps,
          upload_mbps: uploadMbps,
          passed,
        });

        const icon = passed ? 'PASS' : 'FAIL';
        console.log(
          `[Speedtest CLI] ${i}회차: ${downloadMbps.toFixed(1)} Mbps / ${uploadMbps.toFixed(1)} Mbps / ${output.ping.latency.toFixed(1)} ms [${icon}]` +
          (output.server.name ? ` (${output.server.name})` : ''),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${i}회차 실패: ${msg}`);
        console.error(`[Speedtest CLI] ${i}회차 측정 실패: ${msg}`);
      }
    }

    if (rounds.length === 0) {
      return {
        download_mbps: 0,
        upload_mbps: 0,
        ping_ms: 0,
        sla_result: 'unknown',
        complaint_filed: false,
        complaint_result: 'not_applicable',
        raw_data: { total: 0, satisfy: 0, fail: 0, rounds: [] },
        error: `모든 측정 실패: ${errors.join('; ')}`,
      };
    }

    const avgDownload = rounds.reduce((s, r) => s + r.download_mbps, 0) / rounds.length;
    const avgUpload = rounds.reduce((s, r) => s + r.upload_mbps, 0) / rounds.length;
    const failCount = rounds.filter(r => !r.passed).length;
    const slaResult = judgeSLA(rounds);

    if (slaResult === 'fail') {
      console.log('');
      console.log('='.repeat(60));
      console.log('  [참고용] SLA 기준 미달 감지');
      console.log(`  ${rounds.length}회 중 ${failCount}회 최저보장속도 미달`);
      console.log('');
      console.log('  * 이 결과는 Ookla Speedtest CLI 기반 참고용 측정입니다.');
      console.log('  * 공식 SLA 감면 증빙으로 사용할 수 없습니다.');
      console.log('  * 공식 측정은 LGU+ 속도측정 페이지에서 진행해주세요.');
      console.log('='.repeat(60));
      console.log('');
    }

    return {
      download_mbps: avgDownload,
      upload_mbps: avgUpload,
      ping_ms: lastPingMs,
      sla_result: slaResult,
      complaint_filed: false,
      complaint_result: 'not_applicable',
      raw_data: {
        total: rounds.length,
        satisfy: rounds.length - failCount,
        fail: failCount,
        rounds,
      },
      error: errors.length > 0 ? errors.join('; ') : '',
    };
  }
}
