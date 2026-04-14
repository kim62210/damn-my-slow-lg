/**
 * 측정 결과 저장소
 * Node 22.5+ node:sqlite 사용, 미지원 시 JSON 폴백
 */

import fs from 'fs';
import path from 'path';
import type { SpeedTestRecord, SpeedTestResult } from '../types';

interface DBDriver {
  insert(record: SpeedTestRecord): void;
  getAll(): SpeedTestRecord[];
  getRecent(limit: number): SpeedTestRecord[];
  getTodayRecords(): SpeedTestRecord[];
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

  getTodayRecords(): SpeedTestRecord[] {
    const today = new Date().toISOString().slice(0, 10);
    return this.records.filter(r => r.tested_at.startsWith(today));
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

  getTodayRecords(): SpeedTestRecord[] {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.prepare(
      "SELECT * FROM speed_tests WHERE tested_at LIKE ? || '%' ORDER BY id DESC"
    ).all(today);
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

export function resultToRecord(result: SpeedTestResult): SpeedTestRecord {
  return {
    isp: 'lguplus',
    tested_at: new Date().toISOString(),
    download_mbps: result.download_mbps,
    upload_mbps: result.upload_mbps,
    ping_ms: result.ping_ms,
    sla_result: result.sla_result,
    complaint_filed: result.complaint_filed,
    complaint_result: result.complaint_result,
    raw_data: JSON.stringify(result.raw_data),
  };
}
