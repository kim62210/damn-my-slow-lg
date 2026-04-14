import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDB, resultToRecord } from '../src/core/db';
import type { SpeedTestRecord, SpeedTestResult } from '../src/types';

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `damn-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeRecord(overrides: Partial<SpeedTestRecord> = {}): SpeedTestRecord {
  return {
    isp: 'lguplus',
    tested_at: new Date().toISOString(),
    download_mbps: 300,
    upload_mbps: 150,
    ping_ms: 5,
    sla_result: 'pass',
    complaint_filed: false,
    complaint_result: 'skipped',
    raw_data: '{}',
    ...overrides,
  };
}

let cleanupPaths: string[] = [];

afterEach(() => {
  for (const p of cleanupPaths) {
    // SQLite WAL/SHM, JSON 폴백 파일 모두 정리
    const variants = [p, `${p}-wal`, `${p}-shm`, p.replace(/\.db$/, '.json')];
    for (const f of variants) {
      try { fs.unlinkSync(f); } catch { /* 이미 삭제됨 */ }
    }
  }
  cleanupPaths = [];
});

describe('JsonDriver', () => {
  it('파일이 없으면 빈 상태로 시작한다', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    expect(db.getAll()).toEqual([]);
    expect(db.count()).toBe(0);
    db.close();
  });

  it('insert 후 getAll로 조회 가능하다', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    const record = makeRecord();
    db.insert(record);

    const all = db.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].download_mbps).toBe(300);
    expect(all[0].id).toBe(1);
    db.close();
  });

  it('getRecent(n)은 최신 n건을 역순으로 반환한다', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    for (let i = 1; i <= 5; i++) {
      db.insert(makeRecord({ download_mbps: i * 100 }));
    }

    const recent = db.getRecent(3);
    expect(recent).toHaveLength(3);
    // 최신(마지막 insert)부터 역순
    expect(recent[0].download_mbps).toBe(500);
    expect(recent[1].download_mbps).toBe(400);
    expect(recent[2].download_mbps).toBe(300);
    db.close();
  });

  it('getTodayRecords()는 오늘 날짜 레코드만 필터링한다', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86400000).toISOString();

    db.insert(makeRecord({ tested_at: today }));
    db.insert(makeRecord({ tested_at: yesterday }));
    db.insert(makeRecord({ tested_at: today }));

    const todayRecords = db.getTodayRecords();
    expect(todayRecords).toHaveLength(2);
    db.close();
  });

  it('여러 건 insert 후 모두 조회된다', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    db.insert(makeRecord({ download_mbps: 100 }));
    db.insert(makeRecord({ download_mbps: 200 }));
    db.insert(makeRecord({ download_mbps: 300 }));

    const all = db.getAll();
    expect(all).toHaveLength(3);
    // getAll의 정렬 순서는 드라이버마다 다를 수 있으므로 값 존재 여부 확인
    const speeds = all.map(r => r.download_mbps).sort((a, b) => a - b);
    expect(speeds).toEqual([100, 200, 300]);
    db.close();
  });

  it('getRecentByProvider로 ISP별 필터링이 가능하다', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    db.insert(makeRecord({ isp: 'lguplus', download_mbps: 100 }));
    db.insert(makeRecord({ isp: 'skt', download_mbps: 200 }));
    db.insert(makeRecord({ isp: 'lguplus', download_mbps: 300 }));

    const lgRecords = db.getRecentByProvider(10, 'lguplus');
    expect(lgRecords).toHaveLength(2);
    // 역순
    expect(lgRecords[0].download_mbps).toBe(300);
    expect(lgRecords[1].download_mbps).toBe(100);

    const sktRecords = db.getRecentByProvider(10, 'skt');
    expect(sktRecords).toHaveLength(1);
    db.close();
  });

  it('count()가 정확한 건수를 반환한다', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    expect(db.count()).toBe(0);
    db.insert(makeRecord());
    expect(db.count()).toBe(1);
    db.insert(makeRecord());
    db.insert(makeRecord());
    expect(db.count()).toBe(3);
    db.close();
  });
});

describe('hasComplaintSuccessToday / hasSlaFailToday', () => {
  it('오늘 complaint_result=success 레코드가 있으면 true', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    db.insert(makeRecord({ tested_at: new Date().toISOString(), complaint_result: 'success' }));

    expect(db.hasComplaintSuccessToday()).toBe(true);
    expect(db.hasSlaFailToday()).toBe(false);
    db.close();
  });

  it('오늘 sla_result=fail 레코드가 있으면 true', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    db.insert(makeRecord({ tested_at: new Date().toISOString(), sla_result: 'fail' }));

    expect(db.hasSlaFailToday()).toBe(true);
    expect(db.hasComplaintSuccessToday()).toBe(false);
    db.close();
  });

  it('어제 레코드만 있으면 둘 다 false', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    const yesterday = new Date(Date.now() - 86400000).toISOString();
    db.insert(makeRecord({ tested_at: yesterday, sla_result: 'fail', complaint_result: 'success' }));

    expect(db.hasComplaintSuccessToday()).toBe(false);
    expect(db.hasSlaFailToday()).toBe(false);
    db.close();
  });

  it('레코드가 없으면 둘 다 false', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = createDB(dbPath);

    expect(db.hasComplaintSuccessToday()).toBe(false);
    expect(db.hasSlaFailToday()).toBe(false);
    db.close();
  });
});

describe('resultToRecord', () => {
  it('SpeedTestResult를 SpeedTestRecord로 올바르게 변환한다', () => {
    const result: SpeedTestResult = {
      download_mbps: 245.3,
      upload_mbps: 98.7,
      ping_ms: 12,
      sla_result: 'fail',
      complaint_filed: true,
      complaint_result: 'success',
      raw_data: {
        total: 5,
        satisfy: 2,
        fail: 3,
        rounds: [],
      },
      error: '',
    };

    const record = resultToRecord(result);

    expect(record.isp).toBe('lguplus');
    expect(record.download_mbps).toBe(245.3);
    expect(record.upload_mbps).toBe(98.7);
    expect(record.ping_ms).toBe(12);
    expect(record.sla_result).toBe('fail');
    expect(record.complaint_filed).toBe(true);
    expect(record.complaint_result).toBe('success');
    // raw_data는 JSON 문자열로 직렬화
    expect(typeof record.raw_data).toBe('string');
    const parsed = JSON.parse(record.raw_data);
    expect(parsed.total).toBe(5);
    expect(parsed.fail).toBe(3);
    // tested_at은 ISO 날짜 형식
    expect(record.tested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
