/**
 * 측정 결과 저장소
 * Node 22.5+ node:sqlite 사용, 미지원 시 JSON 폴백
 */

import fs from 'fs';
import path from 'path';
import type { SpeedTestRecord, SpeedTestResult } from '../types';

/**
 * KST 기준 오늘 날짜 반환 (YYYY-MM-DD)
 * UTC 기반 toISOString()은 KST 00:00-08:59 사이에 전날 날짜를 반환하므로,
 * 명시적으로 Asia/Seoul 타임존을 사용한다.
 */
function getTodayKST(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export interface DBDriver {
  insert(record: SpeedTestRecord): void;
  getAll(): SpeedTestRecord[];
  getRecent(limit: number): SpeedTestRecord[];
  getRecentByProvider(limit: number, provider: string): SpeedTestRecord[];
  getTodayRecords(): SpeedTestRecord[];
  hasComplaintSuccessToday(): boolean;
  hasSlaFailToday(): boolean;
  count(): number;
  close(): void;
}

/** JSON 파일 기반 폴백 드라이버 */
class JsonDriver implements DBDriver {
  private filePath: string;
  private records: SpeedTestRecord[] = [];

  constructor(dbPath: string) {
    this.filePath = dbPath.replace(/\.db$/, '.json');
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.filePath)) {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.records = JSON.parse(raw) as SpeedTestRecord[];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), 'utf-8');
  }

  insert(record: SpeedTestRecord): void {
    record.id = this.records.length + 1;
    this.records.push(record);
    this.save();
  }

  getAll(): SpeedTestRecord[] {
    return [...this.records];
  }

  getRecent(limit: number): SpeedTestRecord[] {
    return this.records.slice(-limit).reverse();
  }

  getRecentByProvider(limit: number, provider: string): SpeedTestRecord[] {
    return this.records
      .filter(r => r.isp === provider)
      .slice(-limit)
      .reverse();
  }

  getTodayRecords(): SpeedTestRecord[] {
    const today = getTodayKST();
    return this.records.filter(r => r.tested_at.startsWith(today));
  }

  hasComplaintSuccessToday(): boolean {
    const today = getTodayKST();
    return this.records.some(r => r.tested_at.startsWith(today) && r.complaint_result === 'success');
  }

  hasSlaFailToday(): boolean {
    const today = getTodayKST();
    return this.records.some(r => r.tested_at.startsWith(today) && r.sla_result === 'fail');
  }

  count(): number {
    return this.records.length;
  }

  close(): void {
    // JSON 드라이버는 별도 종료 불필요
  }
}

/** SQLite 드라이버 (Node 22.5+ node:sqlite) */
class SqliteDriver implements DBDriver {
  private db: any; // node:sqlite 타입

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS speed_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        isp TEXT NOT NULL DEFAULT 'lguplus',
        tested_at TEXT NOT NULL,
        download_mbps REAL NOT NULL,
        upload_mbps REAL NOT NULL,
        ping_ms REAL NOT NULL DEFAULT 0,
        sla_result TEXT NOT NULL,
        complaint_filed INTEGER NOT NULL DEFAULT 0,
        complaint_result TEXT NOT NULL DEFAULT 'skipped',
        raw_data TEXT NOT NULL DEFAULT '{}'
      )
    `);
  }

  insert(record: SpeedTestRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO speed_tests (isp, tested_at, download_mbps, upload_mbps, ping_ms, sla_result, complaint_filed, complaint_result, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.isp,
      record.tested_at,
      record.download_mbps,
      record.upload_mbps,
      record.ping_ms,
      record.sla_result,
      record.complaint_filed ? 1 : 0,
      record.complaint_result,
      record.raw_data,
    );
  }

  getAll(): SpeedTestRecord[] {
    return this.db.prepare('SELECT * FROM speed_tests ORDER BY id DESC').all();
  }

  getRecent(limit: number): SpeedTestRecord[] {
    return this.db.prepare('SELECT * FROM speed_tests ORDER BY id DESC LIMIT ?').all(limit);
  }

  getRecentByProvider(limit: number, provider: string): SpeedTestRecord[] {
    return this.db.prepare(
      'SELECT * FROM speed_tests WHERE isp = ? ORDER BY id DESC LIMIT ?'
    ).all(provider, limit);
  }

  getTodayRecords(): SpeedTestRecord[] {
    const today = getTodayKST();
    return this.db.prepare(
      "SELECT * FROM speed_tests WHERE tested_at LIKE ? || '%' ORDER BY id DESC"
    ).all(today);
  }

  hasComplaintSuccessToday(): boolean {
    const today = getTodayKST();
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM speed_tests WHERE tested_at LIKE ? || '%' AND complaint_result = 'success'"
    ).get(today);
    return (row?.cnt ?? 0) > 0;
  }

  hasSlaFailToday(): boolean {
    const today = getTodayKST();
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM speed_tests WHERE tested_at LIKE ? || '%' AND sla_result = 'fail'"
    ).get(today);
    return (row?.cnt ?? 0) > 0;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM speed_tests').get();
    return row?.cnt ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function isSqliteAvailable(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

export function createDB(dbPath: string): DBDriver {
  if (isSqliteAvailable()) {
    return new SqliteDriver(dbPath);
  }
  return new JsonDriver(dbPath);
}

export function resultToRecord(result: SpeedTestResult, provider = 'lguplus'): SpeedTestRecord {
  // KST 기준 ISO 문자열 (getTodayRecords와 날짜 기준 일치)
  const now = new Date();
  const kstISO = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
  return {
    isp: provider,
    tested_at: kstISO,
    download_mbps: result.download_mbps,
    upload_mbps: result.upload_mbps,
    ping_ms: result.ping_ms,
    sla_result: result.sla_result,
    complaint_filed: result.complaint_filed,
    complaint_result: result.complaint_result,
    raw_data: JSON.stringify(result.raw_data),
  };
}
