/**
 * LG U+ 속도측정 Provider
 *
 * 측정 플로우:
 * 1. www.lguplus.com 로그인
 * 2. 고객지원 > 간편해결 > 인터넷 속도 측정 이동
 * 3. "최저보장속도 측정(SLA)" 버튼 클릭
 * 4. 5회 자동 측정 완료 대기
 * 5. 결과 파싱 및 SLA 판정
 * 6. 감면 대상 시 알림 (전화 101 안내)
 *
 * NOTE: DOM 선택자는 LGU+ 네트워크에서 `damn-my-slow-lg calibrate` 실행하여 확인 필요.
 *       LGU+ 웹사이트 업데이트 시 선택자가 변경될 수 있음.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { Config, SpeedTestResult, SpeedTestRound } from '../types';
import { getMinGuaranteedSpeed, judgeRound, judgeSLA } from '../core/sla';
import { DATA_DIR } from '../core/config';

/** LGU+ 웹사이트 URL */
const URLS = {
  /** 메인 (Nuxt.js SPA) */
  main: 'https://www.lguplus.com',
  /** 로그인 페이지 */
  login: 'https://www.lguplus.com/login',
  /** 고객지원 > 간편해결 > 인터넷/전화 속도측정 */
  speedTest: 'https://www.lguplus.com/support/internet-phone/speed-check',
  /** 전용 속도측정 서버 (LGU+ 네트워크 전용) */
  speedTestDirect: 'http://speedtest.uplus.co.kr/',
};

/**
 * DOM 선택자 (LGU+ 사이트 구조에 따라 업데이트 필요)
 *
 * `damn-my-slow-lg calibrate` 명령으로 실제 페이지에서 확인 가능.
 * LGU+ 사이트가 Nuxt.js SPA이므로 동적 렌더링 대기 필요.
 */
const SELECTORS = {
  /** 로그인 */
  login: {
    idInput: 'input[name="userId"], input#userId, input[placeholder*="아이디"]',
    passwordInput: 'input[name="userPw"], input#userPw, input[type="password"]',
    submitButton: 'button[type="submit"], button:has-text("로그인")',
    /** 팝업 닫기 (USIM 안내 등) */
    popupClose: 'button:has-text("닫기"), .popup-close, [class*="close"]',
  },
  /** 속도측정 */
  speedTest: {
    /** SLA 측정 시작 버튼 */
    slaButton: 'button:has-text("최저보장속도"), button:has-text("SLA"), a:has-text("SLA")',
    /** 일반 속도측정 시작 버튼 */
    startButton: 'button:has-text("측정 시작"), button:has-text("속도측정"), button:has-text("시작")',
    /** 측정 진행 중 표시 */
    progressIndicator: '[class*="progress"], [class*="loading"], .measuring',
    /** 측정 완료 표시 */
    completeIndicator: '[class*="complete"], [class*="result"], .test-complete',
    /** 다운로드 속도 결과 */
    downloadResult: '[class*="download"] [class*="speed"], [class*="download"] [class*="value"]',
    /** 업로드 속도 결과 */
    uploadResult: '[class*="upload"] [class*="speed"], [class*="upload"] [class*="value"]',
    /** 핑 결과 */
    pingResult: '[class*="ping"] [class*="value"], [class*="latency"]',
    /** SLA 판정 결과 (통과/미달) */
    slaResultText: '[class*="result"], [class*="sla-result"]',
    /** 개별 라운드 결과 행 */
    roundRows: 'table tr, [class*="round"], [class*="step"]',
  },
  /** 회선 선택 (다회선 사용자) */
  lineSelect: {
    lineOptions: 'label:has-text("회선"), [class*="line-select"] option',
    confirmButton: 'button:has-text("확인"), button:has-text("선택")',
  },
};

/** 폴링 간격 (ms) */
const POLL_INTERVAL = 15_000;
/** 측정 타임아웃 (ms) - 40분 */
const MEASURE_TIMEOUT = 40 * 60 * 1000;
/** 페이지 로드 대기 (ms) */
const PAGE_LOAD_WAIT = 5_000;

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
    this.browser = await chromium.launch({
      headless: this.config.headless,
    });
    this.context = await this.browser.newContext({
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
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

  /** LGU+ 로그인 */
  private async login(): Promise<void> {
    const page = this.getPage();
    const { credentials } = this.config;

    console.log('[LGU+] 로그인 중...');
    await page.goto(URLS.login, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(PAGE_LOAD_WAIT);

    // 팝업 닫기 시도
    await this.dismissPopups();

    // 아이디 입력
    const idInput = await page.waitForSelector(SELECTORS.login.idInput, { timeout: 10_000 });
    if (!idInput) throw new Error('로그인 아이디 입력란을 찾을 수 없습니다.');
    await idInput.fill(credentials.id);

    // 비밀번호 입력
    const pwInput = await page.waitForSelector(SELECTORS.login.passwordInput, { timeout: 5_000 });
    if (!pwInput) throw new Error('비밀번호 입력란을 찾을 수 없습니다.');
    await pwInput.fill(credentials.password);

    // 로그인 버튼 클릭
    const submitBtn = await page.waitForSelector(SELECTORS.login.submitButton, { timeout: 5_000 });
    if (!submitBtn) throw new Error('로그인 버튼을 찾을 수 없습니다.');
    await submitBtn.click();

    // 로그인 완료 대기
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(PAGE_LOAD_WAIT);

    // 비밀번호 변경 안내 등 팝업 닫기
    await this.dismissPopups();

    console.log('[LGU+] 로그인 완료');
  }

  /** 팝업 닫기 (USIM 안내, 비밀번호 변경 등) */
  private async dismissPopups(): Promise<void> {
    const page = this.getPage();
    const closeSelectors = [
      SELECTORS.login.popupClose,
      'button:has-text("확인")',
      'button:has-text("다음에")',
      'button:has-text("나중에")',
    ];

    for (const selector of closeSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn && await btn.isVisible()) {
          await btn.click();
          await page.waitForTimeout(1000);
        }
      } catch {
        // 팝업이 없으면 무시
      }
    }
  }

  /** 속도측정 페이지로 이동 */
  private async navigateToSpeedTest(): Promise<void> {
    const page = this.getPage();

    console.log('[LGU+] 속도측정 페이지 이동 중...');

    // 직접 URL 접근 시도
    await page.goto(URLS.speedTest, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(PAGE_LOAD_WAIT);
    await this.dismissPopups();

    // SLA 전용 측정 페이지로 리다이렉트될 수 있음
    // 페이지 URL 확인
    const currentUrl = page.url();
    console.log(`[LGU+] 현재 페이지: ${currentUrl}`);

    // 메인 페이지로 돌아갔으면 speedtest 서버 직접 시도
    if (currentUrl === URLS.main || currentUrl === `${URLS.main}/`) {
      console.log('[LGU+] 속도측정 페이지 접근 실패, 직접 측정 서버 시도...');
      await page.goto(URLS.speedTestDirect, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(PAGE_LOAD_WAIT);
    }
  }

  /** SLA 속도측정 실행 (5회 자동 측정) */
  private async runSLAMeasurement(): Promise<SpeedTestRound[]> {
    const page = this.getPage();
    const minSpeed = getMinGuaranteedSpeed(this.config.plan.speed_mbps);
    const rounds: SpeedTestRound[] = [];

    // SLA 측정 버튼 찾기
    console.log('[LGU+] SLA 측정 버튼 탐색 중...');
    let slaButton = await page.$(SELECTORS.speedTest.slaButton);

    if (!slaButton) {
      // SLA 전용 버튼이 없으면 일반 측정 버튼 사용
      console.log('[LGU+] SLA 전용 버튼 없음, 일반 측정으로 진행');
      slaButton = await page.$(SELECTORS.speedTest.startButton);
    }

    if (!slaButton) {
      throw new Error(
        '속도측정 버튼을 찾을 수 없습니다.\n' +
        '`damn-my-slow-lg calibrate` 명령으로 DOM 선택자를 확인해주세요.'
      );
    }

    // 회선 선택이 필요한 경우
    const lineOption = await page.$(SELECTORS.lineSelect.lineOptions);
    if (lineOption) {
      console.log('[LGU+] 회선 선택 중...');
      await lineOption.click();
      const confirmBtn = await page.$(SELECTORS.lineSelect.confirmButton);
      if (confirmBtn) await confirmBtn.click();
      await page.waitForTimeout(2000);
    }

    // 측정 시작
    console.log('[LGU+] 속도 측정 시작...');
    await slaButton.click();

    // SLA 측정 (5회) 또는 일반 측정 (1회) 완료 대기
    const startTime = Date.now();

    while (Date.now() - startTime < MEASURE_TIMEOUT) {
      await page.waitForTimeout(POLL_INTERVAL);

      // 결과 파싱 시도
      const parsed = await this.parseResults();
      if (parsed.length > 0) {
        for (const r of parsed) {
          r.passed = judgeRound(r.download_mbps, minSpeed);
          rounds.push(r);
        }
        break;
      }

      // 진행 상태 확인
      const isStillMeasuring = await page.$(SELECTORS.speedTest.progressIndicator);
      if (!isStillMeasuring) {
        // 측정이 끝났는데 결과가 없으면 단일 측정 결과 시도
        const singleResult = await this.parseSingleResult();
        if (singleResult) {
          singleResult.passed = judgeRound(singleResult.download_mbps, minSpeed);
          rounds.push(singleResult);
          break;
        }
      }

      console.log(`[LGU+] 측정 진행 중... (${Math.round((Date.now() - startTime) / 1000)}초 경과)`);
    }

    if (rounds.length === 0) {
      throw new Error('측정 결과를 파싱할 수 없습니다. 타임아웃.');
    }

    return rounds;
  }

  /** SLA 5회 측정 결과 테이블 파싱 */
  private async parseResults(): Promise<SpeedTestRound[]> {
    const page = this.getPage();
    const rounds: SpeedTestRound[] = [];

    try {
      // 결과 테이블/리스트에서 각 라운드 추출
      const rows = await page.$$(SELECTORS.speedTest.roundRows);
      let roundNum = 1;

      for (const row of rows) {
        const text = await row.innerText().catch(() => '');
        // 속도값 추출 (숫자 패턴)
        const speedMatch = text.match(/(\d+\.?\d*)\s*[Mm]bps/gi);
        if (speedMatch && speedMatch.length >= 1) {
          const download = parseFloat(speedMatch[0].replace(/[^0-9.]/g, ''));
          const upload = speedMatch.length >= 2
            ? parseFloat(speedMatch[1].replace(/[^0-9.]/g, ''))
            : 0;

          rounds.push({
            round: roundNum++,
            download_mbps: download,
            upload_mbps: upload,
            passed: false, // 호출자가 설정
          });
        }
      }
    } catch {
      // 파싱 실패 시 빈 배열 반환
    }

    return rounds;
  }

  /** 단일 측정 결과 파싱 */
  private async parseSingleResult(): Promise<SpeedTestRound | null> {
    const page = this.getPage();

    try {
      const downloadEl = await page.$(SELECTORS.speedTest.downloadResult);
      if (!downloadEl) return null;

      const downloadText = await downloadEl.innerText();
      const download = parseFloat(downloadText.replace(/[^0-9.]/g, ''));
      if (isNaN(download)) return null;

      let upload = 0;
      const uploadEl = await page.$(SELECTORS.speedTest.uploadResult);
      if (uploadEl) {
        const uploadText = await uploadEl.innerText();
        upload = parseFloat(uploadText.replace(/[^0-9.]/g, '')) || 0;
      }

      let ping = 0;
      const pingEl = await page.$(SELECTORS.speedTest.pingResult);
      if (pingEl) {
        const pingText = await pingEl.innerText();
        ping = parseFloat(pingText.replace(/[^0-9.]/g, '')) || 0;
      }

      return {
        round: 1,
        download_mbps: download,
        upload_mbps: upload,
        passed: false,
      };
    } catch {
      return null;
    }
  }

  /** HTML 스냅샷 저장 (증거 보존) */
  private async saveSnapshot(label: string): Promise<string> {
    const page = this.getPage();
    const snapshotDir = path.join(DATA_DIR, 'snapshots');

    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const htmlPath = path.join(snapshotDir, `lguplus-${label}-${timestamp}.html`);
    const screenshotPath = path.join(snapshotDir, `lguplus-${label}-${timestamp}.png`);

    const html = await page.content();
    fs.writeFileSync(htmlPath, html, 'utf-8');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`[LGU+] 스냅샷 저장: ${htmlPath}`);
    return htmlPath;
  }

  /** 전체 속도측정 + SLA 판정 실행 */
  async run(dryRun = false): Promise<SpeedTestResult> {
    try {
      await this.init();
      await this.login();
      await this.navigateToSpeedTest();

      // 속도측정 전 스냅샷
      await this.saveSnapshot('before-test');

      // SLA 측정 (5회)
      const rounds = await this.runSLAMeasurement();

      // 결과 스냅샷
      await this.saveSnapshot('after-test');

      // SLA 판정
      const slaResult = judgeSLA(rounds);
      const totalDownload = rounds.reduce((sum, r) => sum + r.download_mbps, 0) / rounds.length;
      const totalUpload = rounds.reduce((sum, r) => sum + r.upload_mbps, 0) / rounds.length;
      const failCount = rounds.filter(r => !r.passed).length;

      const result: SpeedTestResult = {
        download_mbps: totalDownload,
        upload_mbps: totalUpload,
        ping_ms: 0,
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
      };

      // SLA 미달 시 안내 (LGU+는 전화 감면 신청)
      if (slaResult === 'fail' && !dryRun) {
        console.log('');
        console.log('='.repeat(60));
        console.log('  SLA 기준 미달 확인!');
        console.log(`  ${rounds.length}회 중 ${failCount}회 최저보장속도 미달`);
        console.log('');
        console.log('  >>> 101 (LGU+ 고객센터)에 전화하여 요금 감면을 신청하세요.');
        console.log('  >>> "SLA 기준 미달로 당일 요금 감면 신청합니다" 라고 말씀하세요.');
        console.log('='.repeat(60));
        console.log('');
        result.complaint_result = 'skipped';
      }

      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // 에러 시에도 스냅샷 시도
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
   * headless=false로 브라우저를 열어 사용자가 직접 DOM 구조를 확인할 수 있게 함
   */
  async calibrate(): Promise<void> {
    console.log('[LGU+] 캘리브레이션 모드 시작');
    console.log('[LGU+] headless=false로 브라우저를 엽니다.');
    console.log('[LGU+] LGU+ 속도측정 페이지에서 DOM 구조를 확인해주세요.');
    console.log('');

    const origHeadless = this.config.headless;
    this.config.headless = false;

    try {
      await this.init();
      await this.login();
      await this.navigateToSpeedTest();

      const page = this.getPage();
      console.log(`[LGU+] 현재 URL: ${page.url()}`);
      console.log('[LGU+] 브라우저에서 DevTools(F12)를 열어 DOM을 확인하세요.');
      console.log('[LGU+] 확인할 요소:');
      console.log('  1. SLA 측정 버튼의 선택자');
      console.log('  2. 측정 결과 테이블/목록의 선택자');
      console.log('  3. 다운로드/업로드 속도값의 선택자');
      console.log('');
      console.log('[LGU+] 스냅샷을 저장합니다...');
      await this.saveSnapshot('calibrate');

      // 사용자가 브라우저를 닫을 때까지 대기
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
}
