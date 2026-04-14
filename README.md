# damn-my-slow-lg

LG U+ 인터넷 SLA 속도 미달 시 요금 감면을 도와주는 CLI 도구.

> [damn-my-slow-kt](https://github.com/kargnas/damn-my-slow-kt)에서 영감을 받아 LG U+ 전용으로 제작.

## 동작 원리

방통위 고시에 따라 모든 통신사는 계약 속도의 **50% 이상**을 보장해야 합니다.
30분 동안 5회 측정 시 **3회 이상** 최저보장속도 미달이면 **당일 요금 감면** 대상입니다.

이 도구는:
1. Playwright(headless Chrome)로 LG U+ OAuth2 허브(account.lguplus.com) 경유 자동 로그인
2. 속도측정 페이지에서 SLA 5회 측정을 자동 실행 (page.evaluate 폴링, 15초 간격)
3. 결과를 DB에 기록하고 Discord/Telegram으로 알림
4. SLA 미달 시 **101(고객센터) 전화 안내** 발송
5. 연속 에러 시 **알림 throttle** (동일 에러 3회 이상 반복 시 24시간 1회)
6. `stop_on_complaint_success` 활성화 시 당일 감면 성공/SLA 미달 확인 후 추가 측정 스킵

LGU+ 네트워크 외부에서는 **Ookla Speedtest CLI**를 fallback 측정 수단으로 사용할 수 있습니다.
단, Ookla 측정 결과는 참고용이며 공식 SLA 감면 증빙으로는 사용할 수 없습니다.

> **Note:** KT와 달리 LG U+는 온라인 감면 신청이 불가하여, 전화(101) 신청이 필요합니다.

## 요구사항

- Node.js 20+ (SQLite 사용 시 22.5+)
- LG U+ 네트워크에 연결된 환경
- LG U+ 웹사이트 계정

## 설치

```bash
npm install -g damn-my-slow-lg

# Playwright 브라우저 설치
npx playwright install chromium
```

## 사용법

### 1. 초기 설정

```bash
damn-my-slow-lg init
```

LG U+ 계정, 요금제, 알림 설정을 대화형으로 입력합니다.

### 2. DOM 캘리브레이션

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

### 3. 속도 측정

```bash
# LG U+ 공식 SLA 측정 (기본)
damn-my-slow-lg run

# dry-run (감면 안내 없이 측정만)
damn-my-slow-lg run --dry-run

# Ookla Speedtest CLI로 측정 (참고용)
damn-my-slow-lg run --provider ookla
```

### 4. 자동 스케줄 등록

```bash
# 등록 (기본: 04시부터 2시간 간격, 최대 10회/일)
damn-my-slow-lg schedule

# 해제
damn-my-slow-lg schedule --uninstall
```

### 5. 측정 이력 조회

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

### 6. 상태 확인

```bash
damn-my-slow-lg status
```

설정 파일 존재 여부, DB 레코드 수, 최근 측정 결과, 스케줄러 등록 상태, Ookla Speedtest CLI 설치 여부를 한눈에 보여줍니다.

## 알림 설정

### Discord

1. 서버 설정 > 연동 > 웹훅 > 새 웹훅 생성
2. 웹훅 URL 복사
3. `damn-my-slow-lg init`에서 입력

### Telegram

1. [@BotFather](https://t.me/BotFather)에서 봇 생성, 토큰 획득
2. 봇에게 `/start` 전송 후 Chat ID 확인
3. `damn-my-slow-lg init`에서 입력

## SLA 기준

| 요금제 | 계약 속도 | 최저보장속도 (50%) |
|--------|----------|-------------------|
| 100M | 100 Mbps | 50 Mbps |
| 500M | 500 Mbps | 250 Mbps |
| 1G | 1,000 Mbps | 500 Mbps |
| 10G | 10,000 Mbps | 5,000 Mbps |

- 5회 중 3회 이상 미달 -> 당일 요금 감면
- 월 5일 이상 감면 -> 위약금 없이 해지 가능

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
    notify.ts           # Discord/Telegram 알림 + 에러 throttle
    scheduler.ts        # launchd/crontab 등록
    sla.ts              # SLA 판정 로직
  providers/
    lguplus.ts          # LG U+ Playwright 자동화
    speedtest-cli.ts    # Ookla Speedtest CLI 래퍼 (fallback)
tests/
  db.test.ts            # DB 드라이버 테스트
  scheduler.test.ts     # 스케줄러 테스트
  sla.test.ts           # SLA 판정 테스트
  config.test.ts        # 설정 테스트
  notify.test.ts        # 알림 테스트
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
