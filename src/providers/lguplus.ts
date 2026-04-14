/**
 * LG U+ 속도측정 Provider
 *
 * 측정 플로우:
 * 1. account.lguplus.com OAuth2 허브 경유 로그인
 *    - www.lguplus.com/login -> account.lguplus.com/login 리다이렉트
 *    - "U+ID" 버튼 클릭 -> /login/email 페이지
 *    - input[name="id"] / input[name="password"] 입력 -> submit
 *    - reCAPTCHA v3 (invisible) 자동 통과
 * 2. 속도측정 페이지 이동 (Nuxt.js SPA)
 * 3. 측정대상(회선) 라디오 선택
 * 4. SLA(5회) 또는 일반(1회) 측정 버튼 클릭 -> myspeed.uplus.co.kr 새 탭
 *    - SLA: myspeed.uplus.co.kr/sla/?user-id=XXX (5회 측정)
 *    - 일반: myspeed.uplus.co.kr/speed/?user-id=XXX (1회 측정)
 * 5. 새 탭에서 측정 프로그램 연결 대기 -> 측정 실행
 * 6. 결과 수집: myspeed 실시간 파싱 또는 이력 탭 fallback
 *    - SLA 페이지는 div 기반 레이아웃 (table 태그 없음) -> body.innerText 정규식 파싱
 *    - SLA 감면 API: /api/v1/update_sla_claim (myspeed 도메인, 향후 확장용)
 *
 * 주요 특징:
 * - CSS 해시 클래스 사용 금지 (Nuxt.js SPA, 빌드마다 변경됨)
 * - 새 탭 핸들링: context.waitForEvent('page')
 * - 측정 프로그램 미설치 시 이력 탭 fallback
 * - 모든 주요 단계에서 스냅샷 저장
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { Config, SlaSummary, SpeedTestResult, SpeedTestRound } from '../types';
import { getMinGuaranteedSpeed, judgeRound, judgeSLA } from '../core/sla';
import { DATA_DIR } from '../core/config';
import { cleanupSnapshots } from '../core/snapshot';

/** LGU+ 웹사이트 URL */
const URLS = {
  login: 'https://www.lguplus.com/login',
  /** OAuth2 허브 (리다이렉트 목적지) */
  oauthHub: 'https://account.lguplus.com/login',
  /** 이메일 로그인 (U+ID 선택 후) */
  oauthEmail: 'https://account.lguplus.com/login/email',
  /** 속도측정 페이지 */
  speedTest: 'https://www.lguplus.com/support/self-troubleshoot/internet-speed-test',
  /** myspeed 일반 측정 (1회) */
  myspeedNormal: 'https://myspeed.uplus.co.kr/speed/',
  /** myspeed SLA 측정 (5회) */
  myspeedSla: 'https://myspeed.uplus.co.kr/sla/',
};

/** 폴링 간격 (ms) */
const POLL_INTERVAL = 15_000;
/** SLA 측정 타임아웃 (ms) - 25분 (20분 측정 + 5분 여유) */
const SLA_MEASURE_TIMEOUT = 25 * 60 * 1000;
/** 일반 측정 타임아웃 (ms) - 5분 */
const NORMAL_MEASURE_TIMEOUT = 5 * 60 * 1000;
/** 로그인 타임아웃 (ms) */
const LOGIN_TIMEOUT = 30_000;
/** 네비게이션 타임아웃 (ms) */
const NAV_TIMEOUT = 15_000;
/** SPA 렌더링 대기 (ms) */
const SPA_SETTLE = 3_000;
/** 최대 재시도 횟수 */
const MAX_RETRIES = 2;
/** 측정 프로그램 연결 대기 (ms) - 60초 */
const PROGRAM_CONNECT_TIMEOUT = 60_000;
/** 측정 프로그램 감지 폴링 간격 (ms) */
const PROGRAM_POLL_INTERVAL = 3_000;
/** myspeed 로컬 WebSocket 서버 주소 */
const MYSPEED_WS_URL = 'ws://127.0.0.1:7788';

/**
 * 다중 fallback 선택자에서 첫 번째로 보이는 요소를 찾는다.
 * 배열의 각 선택자를 순서대로 시도하여 visible 요소를 반환.
 */
async function findFirstVisible(page: Page, selectors: string[], timeout = 10_000): Promise<ReturnType<Page['locator']> | null> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
          return loc;
        }
      } catch {
        // 다음 선택자 시도
      }
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * 선택자 배열 중 아무거나 클릭 가능하면 클릭한다.
 * 팝업/모달 닫기 등 "있으면 클릭, 없으면 무시" 패턴.
 */
async function tryClick(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await loc.click();
        await page.waitForTimeout(800);
        return true;
      }
    } catch {
      // 다음 선택자 시도
    }
  }
  return false;
}

export class LGUplusProvider {
  private config: Config;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  /** 브라우저 초기화 */
  async init(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: this.config.headless,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('playwright') || msg.toLowerCase().includes('browser') || msg.toLowerCase().includes('chromium') || msg.toLowerCase().includes('executable')) {
        console.error('Playwright Chromium이 설치되지 않았습니다.');
        console.error('다음 명령으로 설치해주세요: npx playwright install chromium');
      }
      throw err;
    }
    this.context = await this.browser.newContext({
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    this.page = await this.context.newPage();
  }

  /** 리소스 정리 */
  async cleanup(): Promise<void> {
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /**
   * LGU+ OAuth2 로그인
   *
   * Step 1: www.lguplus.com/login -> account.lguplus.com/login 리다이렉트
   * Step 2: "U+ID" 버튼 클릭 -> /login/email 페이지
   * Step 3: ID/PW 입력, submit
   */
  private async login(): Promise<void> {
    const page = this.getPage();
    const { credentials } = this.config;

    console.log('[LGU+] 로그인 시작...');

    // Step 1: 로그인 페이지 진입 (OAuth 허브로 리다이렉트됨)
    await page.goto(URLS.login, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT });
    await page.waitForTimeout(SPA_SETTLE);

    // account.lguplus.com 리다이렉트 대기
    try {
      await page.waitForURL('**/account.lguplus.com/**', { timeout: 15_000 });
    } catch {
      // 이미 리다이렉트되었거나 직접 접근된 경우
      console.log(`[LGU+] 현재 URL: ${page.url()}`);
    }

    await this.saveSnapshot('login-hub');

    // Step 2: "U+ID" 버튼 클릭 (OAuth 허브에서 로그인 방식 선택)
    const uplusIdButtonSelectors = [
      'button:has-text("U+ID")',
      'a:has-text("U+ID")',
      'button:has-text("U+ ID")',
      'a:has-text("U+ ID")',
    ];

    const uplusIdBtn = await findFirstVisible(page, uplusIdButtonSelectors, 8_000);
    if (uplusIdBtn) {
      console.log('[LGU+] "U+ID" 버튼 클릭');
      await uplusIdBtn.click();
      await page.waitForTimeout(SPA_SETTLE);
    } else {
      console.log('[LGU+] U+ID 버튼 미발견, 현재 페이지에서 로그인 시도');
    }

    // account.lguplus.com/login/email 페이지 대기
    try {
      await page.waitForURL('**/login/email**', { timeout: 5_000 });
    } catch {
      // 이미 email 페이지이거나 다른 경로
    }

    await this.saveSnapshot('login-email-page');

    // Step 3: ID/PW 입력
    console.log('[LGU+] 자격증명 입력 중...');

    // ID 필드 - input[name="id"] (aria-label="이메일 또는 휴대폰번호")
    const idSelectors = [
      'input[name="id"]',
      'input[aria-label*="이메일"]',
      'input[aria-label*="휴대폰"]',
      'input[placeholder*="이메일"]',
      'input[placeholder*="아이디"]',
    ];

    const idField = await findFirstVisible(page, idSelectors);
    if (!idField) {
      await this.saveSnapshot('login-id-not-found');
      throw new Error(
        '로그인 ID 입력란을 찾을 수 없습니다. ' +
        'account.lguplus.com 페이지 구조가 변경되었을 수 있습니다.'
      );
    }

    await idField.fill(credentials.id);
    await page.waitForTimeout(300);

    // PW 필드 - input[name="password"]
    const pwSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[aria-label*="비밀번호"]',
    ];

    const pwField = await findFirstVisible(page, pwSelectors, 5_000);
    if (!pwField) {
      await this.saveSnapshot('login-pw-not-found');
      throw new Error('비밀번호 입력란을 찾을 수 없습니다.');
    }

    await pwField.fill(credentials.password);
    await page.waitForTimeout(300);

    await this.saveSnapshot('login-filled');

    // 로그인 버튼 클릭 (form 태그 없음, React SPA JS 핸들러)
    // 첫 번째 button[type="submit"] (텍스트 "로그인")
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("로그인")',
    ];

    const submitBtn = await findFirstVisible(page, submitSelectors, 5_000);
    if (!submitBtn) {
      await this.saveSnapshot('login-submit-not-found');
      throw new Error('로그인 버튼을 찾을 수 없습니다.');
    }

    await submitBtn.click();

    // 로그인 완료 대기 (SPA 전환이므로 URL 변화 감지)
    try {
      await page.waitForURL(
        (url) => !url.href.includes('account.lguplus.com/login'),
        { timeout: 15_000 }
      );
    } catch {
      console.log('[LGU+] 로그인 후 URL 전환 대기 타임아웃');
    }

    await page.waitForTimeout(SPA_SETTLE);

    // 비밀번호 변경 안내/팝업 닫기
    await this.dismissPopups();

    // 로그인 성공 확인 (account.lguplus.com에 여전히 있으면 실패)
    const currentUrl = page.url();
    if (currentUrl.includes('account.lguplus.com/login')) {
      await this.saveSnapshot('login-failed');
      throw new Error(
        '로그인에 실패했습니다. 아이디/비밀번호를 확인하세요. ' +
        `현재 URL: ${currentUrl}`
      );
    }

    await this.saveSnapshot('login-success');
    console.log('[LGU+] 로그인 완료');
  }

  /** 팝업/모달 닫기 (비밀번호 변경, USIM 안내, 광고 등) */
  private async dismissPopups(): Promise<void> {
    const popupCloseSelectors = [
      'button:has-text("닫기")',
      'button:has-text("확인")',
      'button:has-text("다음에")',
      'button:has-text("나중에")',
      'button:has-text("다음에 변경")',
      'button[aria-label="닫기"]',
      'button[aria-label="close"]',
    ];

    // 최대 3번 반복 (중첩 팝업 대응)
    for (let i = 0; i < 3; i++) {
      const clicked = await tryClick(this.getPage(), popupCloseSelectors);
      if (!clicked) break;
    }
  }

  /** 속도측정 페이지로 이동 (재시도 포함) */
  private async navigateToSpeedTest(): Promise<void> {
    const page = this.getPage();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      console.log(`[LGU+] 속도측정 페이지 이동 중... (시도 ${attempt + 1}/${MAX_RETRIES + 1})`);

      try {
        await page.goto(URLS.speedTest, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(SPA_SETTLE);

        // 미로그인 시 account.lguplus.com으로 리다이렉트 감지
        if (page.url().includes('account.lguplus.com')) {
          console.log('[LGU+] 로그인 세션 만료, 재로그인 시도');
          await this.login();
          continue;
        }

        await this.dismissPopups();

        // Nuxt.js SPA 콘텐츠 로드 대기 - 측정 관련 요소가 나타날 때까지
        try {
          await page.waitForSelector('table.b-table, button:has-text("측정"), button:has-text("속도")', {
            timeout: 10_000,
          });
        } catch {
          console.log('[LGU+] 속도측정 페이지 콘텐츠 로드 대기 타임아웃 -- 계속 진행');
        }

        console.log(`[LGU+] 속도측정 페이지 도착: ${page.url()}`);
        await this.saveSnapshot('speedtest-page');
        return;
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        console.log(`[LGU+] 페이지 로드 실패, 재시도... (${err instanceof Error ? err.message : err})`);
        await page.waitForTimeout(3_000);
      }
    }
  }

  /**
   * 측정대상(회선) 라디오 버튼 선택
   *
   * "측정대상 선택" 테이블 (class: table b-table)에서
   * 라디오 버튼 input[type="radio"]을 찾아 선택.
   * 단일 회선이면 자동 선택됨.
   */
  private async selectLineIfNeeded(): Promise<void> {
    const page = this.getPage();

    // 측정대상 선택 테이블의 라디오 버튼 탐색
    const radioSelectors = [
      'table.b-table input[type="radio"]',
      'input[type="radio"]',
    ];

    const radio = await findFirstVisible(page, radioSelectors, 5_000);
    if (radio) {
      // 이미 체크되어 있는지 확인
      const isChecked = await radio.isChecked().catch(() => false);
      if (!isChecked) {
        console.log('[LGU+] 첫 번째 회선 라디오 버튼 선택');
        await radio.check();
        await page.waitForTimeout(1_000);
      } else {
        console.log('[LGU+] 회선 이미 선택됨 (단일 회선)');
      }
    } else {
      console.log('[LGU+] 회선 선택 UI 미발견 -- 단일 회선으로 추정');
    }

    await this.saveSnapshot('line-selected');
  }

  /**
   * 측정 버튼 클릭 후 새 탭(myspeed.uplus.co.kr) 감지
   *
   * @param sla true=SLA 5회 측정, false=일반 1회 측정
   * @returns 새 탭 Page 또는 null (새 탭이 열리지 않은 경우)
   */
  private async clickMeasureButton(sla: boolean): Promise<Page | null> {
    const page = this.getPage();
    const context = this.getContext();

    const buttonSelectors = sla
      ? [
          'button:has-text("최저보장속도 측정(SLA)")',
          'button:has-text("최저보장속도 측정")',
          'button:has-text("최저 보장 속도 측정")',
          'button:has-text("SLA")',
        ]
      : [
          'button:has-text("인터넷 속도 측정")',
          'button:has-text("속도 측정")',
          'button:has-text("측정 시작")',
        ];

    const modeLabel = sla ? 'SLA' : '일반';
    console.log(`[LGU+] ${modeLabel} 측정 버튼 탐색 중...`);

    // 버튼 클래스: c-btn-solid-1
    const measureBtn = await findFirstVisible(page, buttonSelectors, 10_000);

    if (!measureBtn) {
      await this.saveSnapshot('measure-button-not-found');
      throw new Error(
        `${modeLabel} 속도측정 버튼을 찾을 수 없습니다. ` +
        '`damn-my-slow-lg calibrate` 명령으로 페이지 구조를 확인해주세요.'
      );
    }

    // 클릭 시 새 탭이 열림 -- promise를 먼저 생성
    const newPagePromise = context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);

    console.log(`[LGU+] ${modeLabel} 측정 버튼 클릭`);
    await measureBtn.click();

    // 새 탭 대기
    const newPage = await newPagePromise;

    if (newPage) {
      await newPage.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
      const newTabUrl = newPage.url();
      console.log(`[LGU+] 새 탭 열림: ${newTabUrl}`);

      // SLA/일반 URL 분기 검증
      const expectedPath = sla ? '/sla/' : '/speed/';
      if (newTabUrl.includes('myspeed.uplus.co.kr') && !newTabUrl.includes(expectedPath)) {
        console.log(`[LGU+] 경고: 예상 경로(${expectedPath})와 다름 -- ${newTabUrl}`);
      }

      await this.saveSnapshotOnPage(newPage, 'new-tab-opened');
      return newPage;
    }

    console.log('[LGU+] 새 탭이 열리지 않음 -- 현재 페이지에서 진행');
    await page.waitForTimeout(SPA_SETTLE);
    await this.saveSnapshot('measure-clicked-no-new-tab');
    return null;
  }

  /**
   * myspeed.uplus.co.kr 새 탭에서 측정 프로그램 연결 감지 및 대기
   *
   * 측정 프로그램은 로컬 WebSocket 서버(ws://127.0.0.1:7788)로 동작.
   * 페이지가 WS에 연결되면 "측정시작" 버튼이 enabled됨.
   * 3초 간격으로 버튼 disabled 속성을 폴링하여 감지.
   *
   * @returns true=프로그램 연결 성공 (측정 진행 가능), false=미설치
   */
  private async waitForMeasureProgram(measurePage: Page): Promise<boolean> {
    console.log(`[LGU+] 측정 프로그램 연결 대기 중... (WebSocket: ${MYSPEED_WS_URL})`);

    const startTime = Date.now();

    while (Date.now() - startTime < PROGRAM_CONNECT_TIMEOUT) {
      const btnState = await measurePage.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const startBtn = buttons.find((b) => (b.innerText || '').includes('측정시작'));
        if (!startBtn) return 'not_found';
        return startBtn.disabled ? 'disabled' : 'enabled';
      }).catch(() => 'error');

      if (btnState === 'enabled') {
        console.log('[LGU+] 측정 프로그램 연결 완료 (측정시작 버튼 활성화)');
        await this.saveSnapshotOnPage(measurePage, 'program-connected');
        return true;
      }

      if (btnState === 'not_found') {
        // 버튼 자체가 없으면 페이지 로드 미완료 -- 계속 대기
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[LGU+] 측정시작 버튼 미발견, 페이지 로드 대기 중... (${elapsed}초 경과)`);
      } else {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[LGU+] 측정시작 버튼 비활성 상태, 프로그램 연결 대기 중... (${elapsed}초 경과)`);
      }

      await measurePage.waitForTimeout(PROGRAM_POLL_INTERVAL);
    }

    // 60초 경과 -- 프로그램 미설치로 판정
    console.log('[LGU+] 측정 프로그램 연결 타임아웃 (60초) -- 미설치로 판정');
    await this.saveSnapshotOnPage(measurePage, 'program-connect-timeout');
    return false;
  }

  /**
   * myspeed 페이지에서 "측정시작" 버튼을 찾아 클릭
   *
   * CSS class는 빌드 해시값이라 텍스트 기반으로만 선택.
   */
  private async clickStartMeasure(measurePage: Page): Promise<void> {
    console.log('[LGU+] myspeed "측정시작" 버튼 클릭');

    const clicked = await measurePage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const startBtn = buttons.find((b) => (b.innerText || '').includes('측정시작') && !b.disabled);
      if (startBtn) {
        startBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      await this.saveSnapshotOnPage(measurePage, 'start-button-click-failed');
      throw new Error(
        'myspeed 페이지에서 활성화된 "측정시작" 버튼을 찾을 수 없습니다.'
      );
    }

    await this.saveSnapshotOnPage(measurePage, 'start-button-clicked');
  }

  /**
   * 방식 A: myspeed.uplus.co.kr 페이지에서 실시간 결과 파싱
   *
   * SLA (/sla/) 페이지:
   *   - "SLA 측정결과" 섹션에서 요약 정보 파싱
   *   - div 기반 라운드 테이블에서 1~5회차 결과 파싱 (table 태그 아님)
   *   - 완료 감지: "측정 횟수: 5 회" 또는 5회차 데이터 존재
   *
   * 일반 (/speed/) 페이지:
   *   - 기존 방식: 다운로드/업로드/RTT 파싱
   */
  private async pollMyspeedResults(measurePage: Page, sla: boolean): Promise<SpeedTestRound[]> {
    const minSpeed = getMinGuaranteedSpeed(this.config.plan.speed_mbps);
    const timeout = sla ? SLA_MEASURE_TIMEOUT : NORMAL_MEASURE_TIMEOUT;
    const startTime = Date.now();
    let lastRoundCount = 0;

    // "측정시작" 버튼 클릭하여 측정 시작
    await this.clickStartMeasure(measurePage);

    const modeLabel = sla ? 'SLA 5회' : '일반 1회';
    console.log(`[LGU+] myspeed 페이지에서 측정 결과 대기 중 (${modeLabel})...`);

    while (Date.now() - startTime < timeout) {
      await measurePage.waitForTimeout(POLL_INTERVAL);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (sla) {
        // SLA 페이지 (/sla/) 전용 파싱
        const parsed = await this.parseSlaPage(measurePage);

        if (parsed.rounds.length > lastRoundCount) {
          const latest = parsed.rounds[parsed.rounds.length - 1];
          console.log(
            `[LGU+] SLA ${latest.round}회차 결과: DL=${latest.download_mbps}Mbps UL=${latest.upload_mbps}Mbps ` +
            `RTT=${latest.ping_ms ?? 0}ms ${latest.passed ? '충족' : '미달'} (${elapsed}초 경과)`
          );
          lastRoundCount = parsed.rounds.length;
          await this.saveSnapshotOnPage(measurePage, `myspeed-sla-round-${lastRoundCount}`);
        }

        if (parsed.isComplete) {
          console.log(`[LGU+] SLA 측정 완료 (${parsed.rounds.length}회차)`);
          await this.saveSnapshotOnPage(measurePage, 'myspeed-sla-complete');

          // slaSummary를 임시 저장 (run()에서 사용)
          this._lastSlaSummary = parsed.summary ?? undefined;

          return parsed.rounds;
        }

        if (parsed.rounds.length === 0) {
          console.log(`[LGU+] SLA 측정 진행 중... (${elapsed}초 경과)`);
        }
      } else {
        // 일반 페이지 (/speed/) 파싱
        const parsed = await this.parseNormalPage(measurePage);

        if (parsed.hasResults && parsed.downloadMbps > 0 && lastRoundCount === 0) {
          console.log(
            `[LGU+] 측정 결과 감지: DL=${parsed.downloadMbps}Mbps UL=${parsed.uploadMbps}Mbps RTT=${parsed.latencyMs}ms (${elapsed}초 경과)`
          );
          lastRoundCount = 1;
          await this.saveSnapshotOnPage(measurePage, 'myspeed-round-1');
        }

        if (parsed.isComplete) {
          console.log('[LGU+] myspeed 측정 완료 감지');
          await this.saveSnapshotOnPage(measurePage, 'myspeed-complete');

          return [{
            round: 1,
            download_mbps: parsed.downloadMbps,
            upload_mbps: parsed.uploadMbps,
            ping_ms: parsed.latencyMs,
            passed: judgeRound(parsed.downloadMbps, minSpeed),
          }];
        }

        if (!parsed.hasResults) {
          console.log(`[LGU+] 측정 진행 중... (${elapsed}초 경과)`);
        }
      }
    }

    console.log('[LGU+] myspeed 측정 타임아웃');
    return [];
  }

  /** SLA 페이지 임시 저장용 */
  private _lastSlaSummary: SlaSummary | undefined;

  /**
   * SLA 페이지 body 텍스트에서 결과 파싱
   *
   * div 기반 레이아웃이므로 body.innerText를 정규식으로 파싱.
   * - SLA 측정결과 요약: 제공 속도, 최저 보장 속도, 평균 DL, 측정 횟수, 기준미달, 최저속도미달%
   * - 라운드 테이블: 1~5회 각각의 DL/UL/RTT/결과
   */
  private async parseSlaPage(measurePage: Page): Promise<{
    rounds: SpeedTestRound[];
    summary: SlaSummary | null;
    isComplete: boolean;
  }> {
    const minSpeed = getMinGuaranteedSpeed(this.config.plan.speed_mbps);

    return measurePage.evaluate((minSpeedArg: number) => {
      const body = document.body.innerText || '';

      // --- SLA 요약 섹션 파싱 ---
      const providedMatch = body.match(/제공\s*속도\s*[:\s]*(\d+\.?\d*)\s*Mbps/);
      const minGuaranteedMatch = body.match(/최저\s*보장\s*속도\s*[:\s]*(\d+\.?\d*)\s*Mbps/);
      const avgDlMatch = body.match(/다운로드\s*속도\s*\(평균\)\s*[:\s]*(\d+\.?\d*)\s*Mbps/);
      const measureCountMatch = body.match(/측정\s*횟수\s*[:\s]*(\d+)\s*회/);
      const failCountMatch = body.match(/기준미달\s*횟수\s*[:\s]*(\d+)\s*회/);
      const failPercentMatch = body.match(/최저속도미달\s*[:\s]*(\d+\.?\d*)\s*%/);

      let summary = null;
      const measureCount = measureCountMatch ? parseInt(measureCountMatch[1], 10) : 0;

      if (measureCount > 0 && avgDlMatch) {
        summary = {
          provided_speed_mbps: providedMatch ? parseFloat(providedMatch[1]) : 0,
          min_guaranteed_mbps: minGuaranteedMatch ? parseFloat(minGuaranteedMatch[1]) : 0,
          avg_download_mbps: parseFloat(avgDlMatch[1]),
          measure_count: measureCount,
          fail_count: failCountMatch ? parseInt(failCountMatch[1], 10) : 0,
          fail_percent: failPercentMatch ? parseFloat(failPercentMatch[1]) : 0,
        };
      }

      // --- 라운드 테이블 파싱 (div 기반, table 태그 아님) ---
      // 패턴: "N회 | YYYY-MM-DD HH:mm:ss | DL | UL | RTT | 충족/미달"
      const rounds: Array<{
        round: number;
        download_mbps: number;
        upload_mbps: number;
        ping_ms: number;
        passed: boolean;
      }> = [];

      const roundPattern = /(\d)회\s+([\d-]+\s+[\d:]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(충족|미달)/g;
      let match;
      while ((match = roundPattern.exec(body)) !== null) {
        const dl = parseFloat(match[3]);
        rounds.push({
          round: parseInt(match[1], 10),
          download_mbps: dl,
          upload_mbps: parseFloat(match[4]),
          ping_ms: parseFloat(match[5]),
          passed: match[6] === '충족',
        });
      }

      // 라운드가 정규식으로 안 잡힐 경우 숫자만 있는 라운드 시도
      // "N회 | 숫자 | 숫자 | 숫자 | 숫자" (결과 텍스트 없이 진행 중인 경우)
      if (rounds.length === 0) {
        const fallbackPattern = /(\d)회\s+([\d-]+\s+[\d:]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/g;
        while ((match = fallbackPattern.exec(body)) !== null) {
          const dl = parseFloat(match[3]);
          rounds.push({
            round: parseInt(match[1], 10),
            download_mbps: dl,
            upload_mbps: parseFloat(match[4]),
            ping_ms: parseFloat(match[5]),
            passed: dl >= minSpeedArg,
          });
        }
      }

      // 완료 감지: 측정 횟수 5회 또는 5개 라운드 모두 데이터 존재
      const isComplete =
        measureCount >= 5 ||
        rounds.length >= 5;

      return { rounds, summary, isComplete };
    }, minSpeed).catch(() => ({
      rounds: [] as SpeedTestRound[],
      summary: null,
      isComplete: false,
    }));
  }

  /**
   * 일반 속도측정 페이지 (/speed/) body 텍스트 파싱
   */
  private async parseNormalPage(measurePage: Page): Promise<{
    downloadMbps: number;
    uploadMbps: number;
    latencyMs: number;
    isComplete: boolean;
    hasResults: boolean;
  }> {
    return measurePage.evaluate(() => {
      const body = document.body.innerText || '';

      let downloadMbps = 0;
      const dlMatch = body.match(/다운로드\s*속도[\s\S]*?(\d+\.?\d*)\s*Mbps/i);
      if (dlMatch) downloadMbps = parseFloat(dlMatch[1]);

      let uploadMbps = 0;
      const ulMatch = body.match(/업로드\s*속도[\s\S]*?(\d+\.?\d*)\s*Mbps/i);
      if (ulMatch) uploadMbps = parseFloat(ulMatch[1]);

      let latencyMs = 0;
      const rttMatch = body.match(/평균\s*\(RTT\)\s*(\d+\.?\d*)\s*ms/i);
      if (rttMatch) latencyMs = parseFloat(rttMatch[1]);

      const hasReadyText = body.includes('준비 중');
      const buttons = Array.from(document.querySelectorAll('button'));
      const startBtn = buttons.find((b) => (b.innerText || '').includes('측정시작'));
      const btnReEnabled = startBtn ? !startBtn.disabled : false;

      const hasResults = downloadMbps > 0;
      const isComplete = hasResults && (!hasReadyText || btnReEnabled);

      return { downloadMbps, uploadMbps, latencyMs, isComplete, hasResults };
    }).catch(() => ({
      downloadMbps: 0, uploadMbps: 0, latencyMs: 0,
      isComplete: false, hasResults: false,
    }));
  }

  /**
   * 방식 B: 이력 탭에서 결과 스크래핑 (프로그램 미설치 fallback)
   *
   * 원래 탭(www.lguplus.com)으로 복귀하여:
   * 1. "속도측정 이력" 탭 클릭
   * 2. "이력 확인" 버튼 클릭
   * 3. 이력 테이블(table.b-table) 파싱
   */
  private async scrapeHistoryTab(): Promise<SpeedTestRound[]> {
    const page = this.getPage();
    const minSpeed = getMinGuaranteedSpeed(this.config.plan.speed_mbps);

    console.log('[LGU+] 이력 탭 fallback: 최근 측정 결과 수집 시도...');

    // "속도측정 이력" 탭 클릭
    const historyTabSelectors = [
      'a:has-text("속도측정 이력")',
      'button:has-text("속도측정 이력")',
      'a:has-text("이력")',
    ];

    const historyTab = await findFirstVisible(page, historyTabSelectors, 5_000);
    if (!historyTab) {
      console.log('[LGU+] 이력 탭을 찾을 수 없음');
      await this.saveSnapshot('history-tab-not-found');
      return [];
    }

    await historyTab.click();
    await page.waitForTimeout(SPA_SETTLE);
    await this.saveSnapshot('history-tab-clicked');

    // "이력 확인" 버튼 클릭
    const historyBtnSelectors = [
      'button:has-text("이력 확인")',
      'button:has-text("조회")',
    ];

    const historyBtn = await findFirstVisible(page, historyBtnSelectors, 5_000);
    if (historyBtn) {
      await historyBtn.click();
      await page.waitForTimeout(SPA_SETTLE);
    }

    await this.saveSnapshot('history-loaded');

    // 이력 테이블 파싱
    // 컬럼: 측정일시, 지연(ms), 손실률(%), 업로드 평균속도(Mbps), 다운로드 평균속도(Mbps)
    const historyData = await page.evaluate(() => {
      const rows: Array<{
        datetime: string;
        latency_ms: number;
        loss_pct: number;
        upload_mbps: number;
        download_mbps: number;
      }> = [];

      const tables = document.querySelectorAll('table.b-table');
      // 이력 테이블에서 tbody > tr 순회
      for (const table of tables) {
        const trs = table.querySelectorAll('tbody tr');
        for (const tr of trs) {
          const tds = tr.querySelectorAll('td');
          if (tds.length >= 5) {
            const datetime = (tds[0].textContent || '').trim();
            const latency = parseFloat((tds[1].textContent || '0').replace(/[^0-9.]/g, ''));
            const loss = parseFloat((tds[2].textContent || '0').replace(/[^0-9.]/g, ''));
            const upload = parseFloat((tds[3].textContent || '0').replace(/[^0-9.]/g, ''));
            const download = parseFloat((tds[4].textContent || '0').replace(/[^0-9.]/g, ''));

            if (download > 0) {
              rows.push({
                datetime,
                latency_ms: latency,
                loss_pct: loss,
                upload_mbps: upload,
                download_mbps: download,
              });
            }
          }
        }
      }

      return rows;
    });

    if (historyData.length === 0) {
      console.log('[LGU+] 이력 데이터 없음');
      return [];
    }

    console.log(`[LGU+] 이력에서 ${historyData.length}건 수집`);

    // 최신 행이 첫 번째 -- 최대 5개까지 사용
    const recentData = historyData.slice(0, 5);

    return recentData.map((row, idx) => ({
      round: idx + 1,
      download_mbps: row.download_mbps,
      upload_mbps: row.upload_mbps,
      ping_ms: row.latency_ms,
      passed: judgeRound(row.download_mbps, minSpeed),
    }));
  }

  /**
   * 측정 실행 (SLA 또는 일반)
   *
   * 1. 회선 선택
   * 2. 측정 버튼 클릭 -> 새 탭 감지
   * 3. 측정 프로그램 연결 대기
   * 4. 방식 A (myspeed 실시간) 또는 방식 B (이력 탭 fallback)
   */
  private async runMeasurement(sla: boolean): Promise<SpeedTestRound[]> {
    // 회선 선택
    await this.selectLineIfNeeded();

    // 측정 버튼 클릭 + 새 탭 감지
    const measurePage = await this.clickMeasureButton(sla);

    if (measurePage) {
      // 새 탭이 열림 -- myspeed.uplus.co.kr
      const programConnected = await this.waitForMeasureProgram(measurePage);

      if (programConnected) {
        // 방식 A: myspeed에서 측정시작 클릭 + 실시간 파싱
        const rounds = await this.pollMyspeedResults(measurePage, sla);

        if (rounds.length > 0) {
          return rounds;
        }

        // 실시간 파싱 실패 시 이력 탭 fallback
        console.log('[LGU+] myspeed 실시간 파싱 실패, 이력 탭 fallback 시도');
      } else {
        // 프로그램 미설치
        console.log('[LGU+] 측정 프로그램이 실행되고 있지 않습니다.');
        console.log('[LGU+] LGU+ 속도측정 프로그램을 설치하고 실행해주세요.');
        console.log('[LGU+] (myspeed.uplus.co.kr 페이지의 "측정 프로그램 다운로드" 버튼에서 설치 가능)');
        console.log(`[LGU+] WebSocket 포트: ${MYSPEED_WS_URL}`);
        console.log('[LGU+] 이력 탭에서 최근 결과 수집 시도');
      }

      // 새 탭 닫기
      await measurePage.close().catch(() => {});
    }

    // 방식 B: 이력 탭 fallback
    const historyRounds = await this.scrapeHistoryTab();

    if (historyRounds.length === 0) {
      await this.saveSnapshot('no-results');
      throw new Error(
        '측정 결과를 수집할 수 없습니다.\n' +
        '측정 프로그램이 실행되고 있지 않습니다.\n' +
        'LGU+ 속도측정 프로그램을 설치하고 실행해주세요.\n' +
        '(myspeed.uplus.co.kr 페이지의 "측정 프로그램 다운로드" 버튼에서 설치 가능)\n' +
        `WebSocket 포트: ${MYSPEED_WS_URL}`
      );
    }

    return historyRounds;
  }

  /** HTML + 스크린샷 스냅샷 저장 */
  private async saveSnapshot(label: string): Promise<string> {
    return this.saveSnapshotOnPage(this.getPage(), label);
  }

  /** 특정 Page 객체에 대한 스냅샷 저장 */
  private async saveSnapshotOnPage(targetPage: Page, label: string): Promise<string> {
    const snapshotDir = path.join(DATA_DIR, 'snapshots');

    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `lguplus-${label}-${timestamp}`;
    const htmlPath = path.join(snapshotDir, `${baseName}.html`);
    const screenshotPath = path.join(snapshotDir, `${baseName}.png`);

    try {
      const html = await targetPage.content();
      fs.writeFileSync(htmlPath, html, 'utf-8');
      await targetPage.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[LGU+] 스냅샷: ${baseName}`);
    } catch (err) {
      console.log(`[LGU+] 스냅샷 저장 실패: ${err instanceof Error ? err.message : err}`);
    }

    return htmlPath;
  }

  /**
   * 전체 속도측정 + SLA 판정 실행
   *
   * @param dryRun true=감면 안내만 하고 실제 신청은 하지 않음
   * @param sla true=SLA 5회 측정, false=일반 1회 측정 (기본: true)
   */
  async run(dryRun = false, sla = true): Promise<SpeedTestResult> {
    cleanupSnapshots(7); // 7일 이상 된 스냅샷 자동 정리

    try {
      await this.init();
      await this.login();
      await this.navigateToSpeedTest();

      await this.saveSnapshot('before-test');

      const rounds = await this.runMeasurement(sla);

      await this.saveSnapshot('after-test');

      // SLA 판정
      const slaResult = judgeSLA(rounds);
      const totalDownload = rounds.reduce((sum, r) => sum + r.download_mbps, 0) / rounds.length;
      const totalUpload = rounds.reduce((sum, r) => sum + r.upload_mbps, 0) / rounds.length;
      const pingsWithValue = rounds.filter((r) => r.ping_ms != null && r.ping_ms > 0);
      const avgPing = pingsWithValue.length > 0
        ? pingsWithValue.reduce((sum, r) => sum + (r.ping_ms ?? 0), 0) / pingsWithValue.length
        : 0;
      const failCount = rounds.filter((r) => !r.passed).length;

      const result: SpeedTestResult = {
        download_mbps: totalDownload,
        upload_mbps: totalUpload,
        ping_ms: avgPing,
        sla_result: slaResult,
        complaint_filed: false,
        complaint_result: 'not_applicable',
        raw_data: {
          total: rounds.length,
          satisfy: rounds.length - failCount,
          fail: failCount,
          rounds,
        },
        error: '',
        sla_summary: sla ? this._lastSlaSummary : undefined,
        sla_claim_api_available: sla ? true : undefined, // myspeed /api/v1/update_sla_claim 존재 확인됨
      };

      // SLA 미달 안내
      if (slaResult === 'fail' && !dryRun) {
        console.log('');
        console.log('='.repeat(60));
        console.log('  SLA 기준 미달 확인!');
        console.log(`  ${rounds.length}회 중 ${failCount}회 최저보장속도 미달`);
        if (this._lastSlaSummary) {
          console.log(`  최저속도미달율: ${this._lastSlaSummary.fail_percent}%`);
        }
        console.log('');
        console.log('  >>> 101 (LGU+ 고객센터)에 전화하여 요금 감면을 신청하세요.');
        console.log('  >>> "SLA 기준 미달로 당일 요금 감면 신청합니다" 라고 말씀하세요.');
        if (sla) {
          console.log('');
          console.log('  [참고] myspeed.uplus.co.kr에 SLA 감면 API(/api/v1/update_sla_claim) 존재 확인');
          console.log('  향후 자동 감면 신청 기능이 추가될 수 있습니다.');
        }
        console.log('='.repeat(60));
        console.log('');
        result.complaint_result = 'skipped';
      }

      // 임시 저장 초기화
      this._lastSlaSummary = undefined;

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      try {
        await this.saveSnapshot('error');
      } catch {
        // 스냅샷 저장 실패 무시
      }

      return {
        download_mbps: 0,
        upload_mbps: 0,
        ping_ms: 0,
        sla_result: 'unknown',
        complaint_filed: false,
        complaint_result: 'not_applicable',
        raw_data: { total: 0, satisfy: 0, fail: 0, rounds: [] },
        error: errorMessage,
      };
    } finally {
      await this.cleanup();
    }
  }

  /**
   * 캘리브레이션 모드
   * headless=false로 브라우저를 열어 DOM 구조를 직접 확인
   */
  async calibrate(): Promise<void> {
    console.log('[LGU+] 캘리브레이션 모드 시작');
    console.log('[LGU+] headless=false로 브라우저를 엽니다.');
    console.log('');

    const origHeadless = this.config.headless;
    this.config.headless = false;

    try {
      await this.init();
      await this.login();
      await this.navigateToSpeedTest();

      const page = this.getPage();
      console.log(`[LGU+] 현재 URL: ${page.url()}`);
      console.log('[LGU+] DevTools(F12)를 열어 확인할 요소:');
      console.log('  1. "최저보장속도 측정(SLA)" 버튼의 선택자');
      console.log('  2. "인터넷 속도 측정" 버튼의 선택자');
      console.log('  3. 측정대상 선택 테이블 (table.b-table) + 라디오 버튼');
      console.log('  4. 새 탭(myspeed.uplus.co.kr) 측정 결과 영역');
      console.log('  5. 이력 탭 테이블 구조');
      console.log('');
      await this.saveSnapshot('calibrate');

      console.log('[LGU+] 브라우저를 닫으면 캘리브레이션이 종료됩니다.');
      await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    } finally {
      this.config.headless = origHeadless;
      await this.cleanup();
    }
  }

  private getPage(): Page {
    if (!this.page) throw new Error('브라우저가 초기화되지 않았습니다.');
    return this.page;
  }

  private getContext(): BrowserContext {
    if (!this.context) throw new Error('브라우저 컨텍스트가 초기화되지 않았습니다.');
    return this.context;
  }
}
