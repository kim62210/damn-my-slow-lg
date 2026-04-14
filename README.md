# damn-my-slow-lg

LG U+ 인터넷 SLA 속도 미달 시 요금 감면을 도와주는 CLI 도구.

> [damn-my-slow-kt](https://github.com/kargnas/damn-my-slow-kt)에서 영감을 받아 LG U+ 전용으로 제작.

## SLA (Service Level Agreement) 제도

방통위 고시에 따라 모든 초고속인터넷 사업자는 계약 속도의 **50% 이상**을 보장해야 합니다.

### 측정 기준

- 30분 동안 5회 측정 (4분 간격)
- 60% 이상 (3회 이상) 최저보장속도 미달 시 **당일 요금 감면** 대상
- 월 5일 이상 감면 시 **위약금 없이 해지 가능**

### 최저보장속도 기준표

| 요금제 | 계약 속도 | 최저보장속도 (50%) |
|--------|----------|-------------------|
| 광랜 100M | 100 Mbps | 50 Mbps |
| 기가 슬림 500M | 500 Mbps | 250 Mbps |
| 기가 인터넷 1G | 1,000 Mbps | 500 Mbps |
| 기가 프리미엄 10G | 10,000 Mbps | 5,000 Mbps |

> 근거: 전기통신사업법, 방송통신위원회 고시

## 동작 원리

1. Playwright(headless Chrome)로 LG U+ OAuth2 허브(`account.lguplus.com`) 경유 자동 로그인
2. 고객지원 > 간편해결 > 인터넷 속도 측정 페이지(`www.lguplus.com`)로 이동
3. "최저보장속도 측정(SLA)" 버튼 클릭 -- `myspeed.uplus.co.kr/sla/` 새 탭 열림
4. 로컬 측정 프로그램(`ws://127.0.0.1:7788`)과 WebSocket 연결
5. 4분 간격 5회 자동 측정 (`page.evaluate` 폴링, 15초 간격 상태 확인)
6. 결과 DB 저장 + Discord/Telegram 알림
7. SLA 미달 시 **101(고객센터) 전화 안내** 발송
8. 연속 에러 시 알림 throttle (동일 에러 3회 이상 반복 시 24시간 1회)
9. `stop_on_complaint_success` 활성화 시 당일 감면 성공/SLA 미달 확인 후 추가 측정 스킵

> **Note:** KT와 달리 LG U+는 온라인 감면 신청이 불가하여, 전화(101) 신청이 필요합니다.

## KT 원본과의 차이점

| 항목 | damn-my-slow-kt (KT) | damn-my-slow-lg (LG U+) |
|------|----------------------|-------------------------|
| 감면 신청 | API 자동 신청 가능 | **전화(101)만 가능** |
| 측정 프로그램 | 불필요 | **필수** (`ws://127.0.0.1:7788`) |
| 측정 방식 | KT 자체 API | Playwright + WebSocket |
| 이력 조회 | API | Playwright 스크래핑 |
| Ookla fallback | X | O (참고용) |
| 이력 스크래핑 | X | O (`--history`, 프로그램 없이 가능) |

- `/api/v1/update_sla_claim` API가 확인되어 향후 자동 감면 신청 가능성 존재

## 요구사항

- Node.js 20+ (SQLite 사용 시 22.5+)
- LG U+ 네트워크에 연결된 환경
- LG U+ 웹사이트 계정
- **LG U+ 속도측정 프로그램** (아래 설치 안내 참조)

## 측정 프로그램 설치

LG U+ SLA 측정은 로컬에서 실행되는 속도측정 프로그램이 필요합니다.
프로그램 설치 후 `ws://127.0.0.1:7788`에서 WebSocket 서버로 동작합니다.

### macOS

1. [myspeed.uplus.co.kr](https://myspeed.uplus.co.kr)에 접속하면 `LGUSpeedMeter_for_Mac.pkg`가 자동 다운로드
2. `.pkg` 파일 실행하여 설치
3. **Gatekeeper 경고 우회**: 시스템 환경설정 > 개인정보 보호 및 보안 > "확인 없이 열기" 클릭

### Windows

1. [myspeed.uplus.co.kr](https://myspeed.uplus.co.kr)에서 `LGUSpeedMeterSetup.exe` 다운로드
2. 설치 프로그램 실행

> `--history` 모드(이력 스크래핑)는 측정 프로그램 없이 사용 가능합니다.

## 설치

```bash
npm install -g damn-my-slow-lg

# Playwright 브라우저 설치
npx playwright install chromium
```

## 사용법

### 1단계: 초기 설정

```bash
damn-my-slow-lg init
```

LG U+ 계정, 요금제, 알림 설정을 대화형으로 입력합니다.

### 2단계: DOM 캘리브레이션

LG U+ 웹사이트 구조가 변경될 수 있으므로, 첫 실행 전에 확인합니다:

```bash
# 브라우저 열기 + DOM 요소 자동 탐지
damn-my-slow-lg calibrate

# DOM 구조를 HTML 파일로 덤프
damn-my-slow-lg calibrate --dump-dom
```

로그인 후 속도측정 페이지로 이동하여 button, input, table, link 요소를 자동 탐지합니다.
결과는 `~/.damn-my-slow-isp/calibrate-lguplus.json`에 저장됩니다.
headless=false 모드로 브라우저가 열리며, DevTools(F12)로 추가 확인할 수 있습니다.

### 3단계: 테스트 실행

```bash
# dry-run (감면 안내 없이 측정만)
damn-my-slow-lg run --dry-run
```

### 4단계: 속도 측정

```bash
# LG U+ 공식 SLA 측정 (기본)
damn-my-slow-lg run

# SLA 5회 연속 측정 모드
damn-my-slow-lg run --sla

# Ookla Speedtest CLI로 측정 (참고용)
damn-my-slow-lg run --provider ookla

# 측정 없이 이력만 스크래핑 (측정 프로그램 불필요)
damn-my-slow-lg run --history
```

### 5단계: 자동 스케줄 등록

```bash
# 등록 (기본: 04시부터 2시간 간격, 최대 10회/일)
damn-my-slow-lg schedule

# 해제
damn-my-slow-lg schedule --uninstall
```

### 측정 이력 조회

```bash
# 최근 10건
damn-my-slow-lg history

# 오늘 기록
damn-my-slow-lg history --today

# 최근 20건
damn-my-slow-lg history -n 20

# 특정 프로바이더만 필터
damn-my-slow-lg history --provider ookla
```

### 상태 확인

```bash
damn-my-slow-lg status
```

설정 파일 존재 여부, DB 레코드 수, 최근 측정 결과, 스케줄러 등록 상태, Ookla Speedtest CLI 설치 여부를 한눈에 보여줍니다.

## CLI 옵션 전체

### `run`

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `--dry-run` | 감면 안내만 하고 실제 신청하지 않음 | `false` |
| `--no-notify` | 알림 발송하지 않음 | - |
| `--provider <provider>` | 측정 프로바이더 (`lguplus` / `ookla`) | `lguplus` |
| `--sla` | SLA 5회 연속 측정 모드 | `false` |
| `--history` | 측정 없이 이력 스크래핑 모드 | `false` |

### `history`

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `-n, --limit <number>` | 표시할 레코드 수 | `10` |
| `--today` | 오늘 기록만 표시 | - |
| `--provider <provider>` | 특정 프로바이더 기록만 필터 | - |

### `calibrate`

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `--dump-dom` | 현재 페이지 DOM 구조를 파일로 덤프 | - |

### `schedule`

| 옵션 | 설명 | 기본값 |
|------|------|--------|
| `--uninstall` | 스케줄 해제 | - |

## 환경변수

설정 파일(`~/.damn-my-slow-isp/config-lguplus.yaml`) 대신 환경변수로도 설정 가능합니다.

| 변수 | 설명 |
|------|------|
| `DMSL_LG_ID` | LG U+ 아이디 |
| `DMSL_LG_PASSWORD` | LG U+ 비밀번호 |
| `DMSL_DISCORD_WEBHOOK` | Discord Webhook URL |
| `DMSL_TELEGRAM_TOKEN` | Telegram Bot Token |
| `DMSL_TELEGRAM_CHAT` | Telegram Chat ID |

## 알림 설정

### Discord

1. 서버 설정 > 연동 > 웹훅 > 새 웹훅 생성
2. 웹훅 URL 복사
3. `damn-my-slow-lg init`에서 입력

### Telegram

1. [@BotFather](https://t.me/BotFather)에서 봇 생성, 토큰 획득
2. 봇에게 `/start` 전송 후 Chat ID 확인
3. `damn-my-slow-lg init`에서 입력

## 설정 파일

`~/.damn-my-slow-isp/config-lguplus.yaml`

```yaml
_config_version: 1
credentials:
  id: "your-id"
  password: "your-pw"
phone: "010-0000-0000"
plan:
  speed_mbps: 500
schedule:
  time: "04:00"
  timezone: "Asia/Seoul"
  max_attempts: 10
  retry_interval_minutes: 120
  stop_on_complaint_success: true  # 당일 감면 성공 또는 SLA 미달 확인 시 추가 측정 스킵
notification:
  discord_webhook: ""
  telegram_bot_token: ""
  telegram_chat_id: ""
headless: true
```

## 프로젝트 구조

```
src/
  index.ts              # 진입점
  cli.ts                # CLI 명령어 (Commander)
  types/
    index.ts            # 타입 정의
  core/
    config.ts           # 설정 관리 (YAML)
    db.ts               # SQLite/JSON 저장소
    lockfile.ts         # 동시 실행 방지 lockfile
    notify.ts           # Discord/Telegram 알림 + 에러 throttle
    scheduler.ts        # launchd/crontab 등록
    sla.ts              # SLA 판정 로직
    snapshot.ts         # 스냅샷 자동 정리
  providers/
    lguplus.ts          # LG U+ Playwright 자동화 (OAuth2 + WebSocket)
    speedtest-cli.ts    # Ookla Speedtest CLI 래퍼 (fallback)
tests/
  config.test.ts        # 설정 테스트
  db.test.ts            # DB 드라이버 테스트
  notify.test.ts        # 알림 테스트
  scheduler.test.ts     # 스케줄러 테스트 (launchd)
  scheduler-crontab.test.ts  # 스케줄러 테스트 (crontab)
  sla.test.ts           # SLA 판정 테스트
```

## 기술 스택

- TypeScript 5.4+ / Node.js 20+
- Playwright (headless Chromium)
- Commander + Inquirer (CLI)
- node:sqlite / JSON 폴백 (DB)
- Axios (알림)
- Vitest (테스트)

## 면책

이 도구는 소비자 권리(약관상 요금 감면) 행사를 돕기 위한 것입니다.
LG U+ 웹사이트 이용약관에 따라 자동화 도구 사용이 제한될 수 있으니 확인 후 사용하세요.

## License

MIT
