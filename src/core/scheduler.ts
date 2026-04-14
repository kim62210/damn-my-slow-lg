/**
 * 시스템 스케줄러 등록
 * - macOS: launchd plist
 * - Linux: systemd timer > crontab
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import type { Schedule } from '../types';

const LABEL = 'com.damn-my-slow-lg.scheduler';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function getExecutablePath(): string {
  // npx 임시 경로 감지 - 안정적인 경로로 폴백
  const current = process.argv[1];
  if (current && !current.includes('_npx')) {
    return current;
  }

  // 글로벌 설치 경로 탐색
  try {
    const globalBin = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const candidate = path.join(globalBin, 'damn-my-slow-lg', 'bin', 'damn-my-slow-lg');
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // 글로벌 설치 아닌 경우 무시
  }

  return current || 'damn-my-slow-lg';
}

export function buildScheduleEntries(schedule: Schedule): Array<{ Hour: number; Minute: number }> {
  const [startHour, startMinute] = schedule.time.split(':').map(Number);
  const entries: Array<{ Hour: number; Minute: number }> = [];
  const intervalMinutes = schedule.retry_interval_minutes;

  for (let i = 0; i < schedule.max_attempts; i++) {
    const totalMinutes = startHour * 60 + startMinute + i * intervalMinutes;
    const hour = Math.floor(totalMinutes / 60) % 24;
    const minute = totalMinutes % 60;
    entries.push({ Hour: hour, Minute: minute });
  }

  return entries;
}

export function installLaunchd(schedule: Schedule): string {
  const execPath = getExecutablePath();
  const nodePath = process.execPath;
  const entries = buildScheduleEntries(schedule);

  const calendarIntervals = entries
    .map(e => `      <dict>
        <key>Hour</key>
        <integer>${e.Hour}</integer>
        <key>Minute</key>
        <integer>${e.Minute}</integer>
      </dict>`)
    .join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${execPath}</string>
    <string>run</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
${calendarIntervals}
  </array>
  <key>StandardOutPath</key>
  <string>${os.homedir()}/.damn-my-slow-isp/scheduler-lguplus.log</string>
  <key>StandardErrorPath</key>
  <string>${os.homedir()}/.damn-my-slow-isp/scheduler-lguplus-error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>`;

  const dir = path.dirname(PLIST_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PLIST_PATH, plist, 'utf-8');

  try {
    execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`, { encoding: 'utf-8' });
  } catch {
    // 이전 등록이 없으면 무시
  }
  execSync(`launchctl load ${PLIST_PATH}`, { encoding: 'utf-8' });

  return PLIST_PATH;
}

export function installCrontab(schedule: Schedule): string {
  const execPath = getExecutablePath();
  const nodePath = process.execPath;
  const entries = buildScheduleEntries(schedule);
  const logPath = path.join(os.homedir(), '.damn-my-slow-isp', 'scheduler-lguplus.log');

  const crontabLines = entries
    .map(e => `${e.Minute} ${e.Hour} * * * ${nodePath} ${execPath} run >> ${logPath} 2>&1`)
    .join('\n');

  const marker = '# damn-my-slow-lg';
  const markerEnd = '# /damn-my-slow-lg';

  let existing = '';
  try {
    existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
  } catch {
    existing = '';
  }

  // 기존 항목 제거
  const cleaned = existing
    .split('\n')
    .filter(line => {
      const inBlock = line.includes(marker) || line.includes(markerEnd);
      return !inBlock;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  const newCrontab = `${cleaned.trim()}\n\n${marker}\n${crontabLines}\n${markerEnd}\n`;

  const tmpFile = path.join(os.tmpdir(), 'damn-my-slow-lg-crontab');
  fs.writeFileSync(tmpFile, newCrontab, 'utf-8');
  execSync(`crontab ${tmpFile}`, { encoding: 'utf-8' });
  fs.unlinkSync(tmpFile);

  return 'crontab';
}

export function installScheduler(schedule: Schedule): string {
  const platform = os.platform();

  if (platform === 'darwin') {
    return installLaunchd(schedule);
  }

  return installCrontab(schedule);
}

export function uninstallScheduler(): void {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      execSync(`launchctl unload ${PLIST_PATH} 2>/dev/null`, { encoding: 'utf-8' });
      if (fs.existsSync(PLIST_PATH)) {
        fs.unlinkSync(PLIST_PATH);
      }
    } catch {
      // 이미 제거됨
    }
    return;
  }

  // crontab 에서 제거
  try {
    const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
    const marker = '# damn-my-slow-lg';
    const markerEnd = '# /damn-my-slow-lg';
    let inBlock = false;
    const cleaned = existing
      .split('\n')
      .filter(line => {
        if (line.includes(marker)) { inBlock = true; return false; }
        if (line.includes(markerEnd)) { inBlock = false; return false; }
        return !inBlock;
      })
      .join('\n');

    const tmpFile = path.join(os.tmpdir(), 'damn-my-slow-lg-crontab');
    fs.writeFileSync(tmpFile, cleaned, 'utf-8');
    execSync(`crontab ${tmpFile}`, { encoding: 'utf-8' });
    fs.unlinkSync(tmpFile);
  } catch {
    // crontab 없음
  }
}
