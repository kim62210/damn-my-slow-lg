/** LG U+ SLA 속도측정 자동화 타입 정의 */

export interface Credentials {
  id: string;
  password: string;
}

export interface Plan {
  /** 계약 속도 (Mbps) */
  speed_mbps: number;
}

export interface Schedule {
  /** 첫 측정 시작 시각 (HH:mm) */
  time: string;
  timezone: string;
  /** 하루 최대 측정 횟수 */
  max_attempts: number;
  /** 재시도 간격 (분) */
  retry_interval_minutes: number;
  /** 감면 신청 성공 시 나머지 시도 중단 */
  stop_on_complaint_success: boolean;
}

export interface Notification {
  discord_webhook: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
}

export interface Config {
  _config_version: number;
  credentials: Credentials;
  /** 감면 신청 시 연락처 */
  phone: string;
  plan: Plan;
  schedule: Schedule;
  notification: Notification;
  headless: boolean;
  db_path: string;
}

/** 개별 측정 라운드 결과 */
export interface SpeedTestRound {
  round: number;
  download_mbps: number;
  upload_mbps: number;
  /** 지연시간 (ms) -- myspeed RTT 또는 이력 탭 지연값 */
  ping_ms?: number;
  /** 최저보장속도 (계약속도의 50%) 충족 여부 */
  passed: boolean;
}

export interface SpeedTestResult {
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  /** SLA 판정 결과 (5회 중 3회 이상 미달 시 fail) */
  sla_result: 'pass' | 'fail' | 'unknown';
  /** 감면 신청 수행 여부 */
  complaint_filed: boolean;
  /** 감면 신청 결과 */
  complaint_result: 'success' | 'failed' | 'skipped' | 'not_applicable';
  raw_data: {
    total: number;
    satisfy: number;
    fail: number;
    rounds: SpeedTestRound[];
  };
  error: string;
}

/** DB에 저장되는 측정 기록 */
export interface SpeedTestRecord {
  id?: number;
  isp: string;
  tested_at: string;
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  sla_result: string;
  complaint_filed: boolean;
  complaint_result: string;
  raw_data: string;
}

/** LG U+ 속도측정 이력 (스크래핑) */
export interface HistoryRecord {
  measured_at: string;     // "2024-03-08 21:21:38"
  latency_ms: number;      // 지연(ms)
  loss_percent: number;    // 손실률(%)
  upload_mbps: number;     // 업로드 평균속도
  download_mbps: number;   // 다운로드 평균속도
}

/** 알림 메시지 포맷 */
export interface NotifyPayload {
  title: string;
  result: SpeedTestResult;
  plan_speed: number;
  min_guaranteed_speed: number;
  timestamp: string;
}
