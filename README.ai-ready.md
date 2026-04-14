# AI Agentic Coding Setup — damn-my-slow-lg

> **이 문서는 AI 에이전트(Codex, Claude Code, OpenCode 등)가 이 프로젝트를 개발/테스트할 때 필요한 환경 설정을 안내합니다.**
> 사람 개발자가 AI 코딩 환경을 구성할 때도 참고하세요.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    damn-my-slow-lg                         │
│                                                           │
│  CLI (Commander)                                          │
│    ├── init       → 설정 wizard (계정, 요금제, 알림)       │
│    ├── run        → Playwright → lguplus.com SLA 측정     │
│    ├── run --sla  → SLA 5회 연속 측정 모드                 │
│    ├── run --history → 측정 없이 이력 스크래핑             │
│    ├── history    → SQLite/JSON DB 조회                   │
│    ├── calibrate  → DOM 요소 자동 탐지 + 덤프             │
│    ├── schedule   → launchd/crontab 등록                  │
│    └── status     → 설정/DB/스케줄 상태 확인               │
│                                                           │
│  측정 프로그램: ws://127.0.0.1:7788 (WebSocket)           │
│  Storage: SQLite (Node 22+) / JSON fallback (20+)        │
│  Config:  ~/.damn-my-slow-isp/config-lguplus.yaml        │
│  No external DB/Redis/Docker required!                   │
└──────────────────────────────────────────────────────────┘
```

---

## Quick Setup (Local Development)

```bash
# 1. Install dependencies (자동으로 TypeScript 빌드까지 실행됨 — prepare 스크립트)
npm install

# 2. Install Playwright browsers (headless Chromium)
npx playwright install chromium

# 3. CLI 글로벌 심볼릭 링크 등록 (선택)
npm link

# 4. Create test config (optional — 실제 LG U+ 측정 시에만 필요)
cp config.yaml.example ~/.damn-my-slow-isp/config-lguplus.yaml
# LG U+ 계정 정보 입력

# 5. Run type check + tests
npm run typecheck
npm test
```

---

## Codex Cloud Setup (Ubuntu 24.04)

> **Codex Cloud는 Docker를 사용할 수 없습니다.**
> 이 프로젝트는 외부 서비스(MySQL, Redis 등)가 불필요하므로 바로 사용 가능합니다.

### Setup Script (네트워크 접근 가능 시)

```bash
#!/bin/bash
# Codex Cloud: 초기 설정 (network enabled)
npm install
npx playwright install-deps chromium  # 시스템 의존성 (Ubuntu)
npx playwright install chromium       # Chromium 브라우저 바이너리
```

### Maintain Script (브랜치 전환 후)

```bash
#!/bin/bash
# Codex Cloud: 브랜치 체크아웃 후 유지보수
npm install
```

---

## Required Secrets

| Secret | Required | Purpose |
|--------|----------|---------|
| LG U+ ID/Password | **Yes** (for `run` only) | LG U+ 계정 — `config-lguplus.yaml`에 설정 |
| Discord Webhook | No | 결과 알림 |
| Telegram Token + Chat ID | No | 결과 알림 |

> **개발/테스트 시에는 credential 없이도** `build`, `typecheck`, `test` 모두 실행 가능합니다.
> `run` 명령만 실제 LG U+ 계정이 필요합니다.

---

## Available Commands

| Command | Description | Needs Credential |
|---------|-------------|-----------------|
| `npm run build` | TypeScript → JavaScript 컴파일 | No |
| `npm run typecheck` | `tsc --noEmit` 타입 체크 | No |
| `npm test` | Vitest 단위 테스트 | No |
| `npm run dev` | ts-node 개발 모드 | No |

---

## KT 원본과의 주요 차이점 (개발 시 주의)

| 항목 | damn-my-slow-kt (KT) | damn-my-slow-lg (LG U+) |
|------|----------------------|-------------------------|
| 감면 신청 | API 자동 신청 가능 | **전화(101)만 가능** |
| 측정 프로그램 | 불필요 | **필수** (`ws://127.0.0.1:7788`) |
| 측정 방식 | KT 자체 API | Playwright + WebSocket |
| 이력 조회 | API | Playwright 스크래핑 |
| DOM 캘리브레이션 | 불필요 | **필요** (LG U+ 웹 구조 변경 대응) |

---

## Tech Stack Summary

| Component | Technology | Notes |
|-----------|-----------|-------|
| Language | TypeScript (ES2020, CommonJS) | `strict: true` |
| Runtime | Node.js 20+ | Node 22+ 권장 (native SQLite) |
| CLI | Commander + Inquirer + Chalk v4 | CJS 호환 버전 |
| Browser | Playwright (Chromium) | LG U+ SLA 측정 자동화 |
| Storage | node:sqlite / JSON fallback | 외부 DB 불필요 |
| HTTP | Axios | 알림 발송 |
| Config | YAML (js-yaml) | `~/.damn-my-slow-isp/config-lguplus.yaml` |
| Test | Vitest | `tests/` directory |
