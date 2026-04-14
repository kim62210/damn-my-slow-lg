/**
 * 동시 실행 방지 lockfile 모듈
 * - PID 기반 lockfile 생성/해제
 * - stale lock 자동 정리
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LOCK_PATH = path.join(os.homedir(), '.damn-my-slow-isp', 'run.lock');

function ensureLockDir(): void {
  const dir = path.dirname(LOCK_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * PID가 실제로 살아있는 프로세스인지 확인
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 다른 프로세스가 실행 중인지 확인
 * stale lock(PID가 죽은 프로세스)은 자동 정리
 */
export function isLocked(): boolean {
  if (!fs.existsSync(LOCK_PATH)) {
    return false;
  }

  try {
    const content = fs.readFileSync(LOCK_PATH, 'utf-8').trim();
    const pid = parseInt(content, 10);

    if (isNaN(pid)) {
      // 비정상 lockfile - 제거
      fs.unlinkSync(LOCK_PATH);
      return false;
    }

    if (pid === process.pid) {
      // 현재 프로세스의 lock
      return false;
    }

    if (!isProcessAlive(pid)) {
      // stale lock 정리
      fs.unlinkSync(LOCK_PATH);
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * PID 기반 lockfile 생성
 * @returns true면 lock 획득 성공, false면 이미 다른 프로세스가 실행 중
 */
export function acquireLock(): boolean {
  ensureLockDir();

  if (isLocked()) {
    return false;
  }

  fs.writeFileSync(LOCK_PATH, String(process.pid), 'utf-8');
  return true;
}

/**
 * lockfile 삭제
 */
export function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const content = fs.readFileSync(LOCK_PATH, 'utf-8').trim();
      const pid = parseInt(content, 10);

      // 자신의 lock만 해제
      if (pid === process.pid) {
        fs.unlinkSync(LOCK_PATH);
      }
    }
  } catch {
    // 이미 제거됨
  }
}
