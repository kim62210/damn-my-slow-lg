/**
 * 스냅샷 관리 모듈
 * - 스냅샷 파일 저장 및 오래된 파일 자동 정리
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const SNAPSHOT_DIR = path.join(os.homedir(), '.damn-my-slow-isp', 'snapshots');

function ensureSnapshotDir(): void {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * maxAgeDays 이상 된 스냅샷 파일 삭제
 * @returns 삭제된 파일 수
 */
export function cleanupSnapshots(maxAgeDays: number): number {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    return 0;
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(SNAPSHOT_DIR);
  let removed = 0;

  for (const file of files) {
    const filePath = path.join(SNAPSHOT_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      // 파일 접근 불가 시 스킵
    }
  }

  return removed;
}

/**
 * 페이지 스냅샷(스크린샷) 저장
 * @param page - Playwright Page 객체
 * @param label - 스냅샷 식별 라벨
 * @returns 저장된 파일 경로
 */
export async function saveSnapshot(page: { screenshot: (opts: { path: string }) => Promise<Buffer> }, label: string): Promise<string> {
  ensureSnapshotDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sanitizedLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${timestamp}_${sanitizedLabel}.png`;
  const filePath = path.join(SNAPSHOT_DIR, filename);

  await page.screenshot({ path: filePath });

  return filePath;
}
