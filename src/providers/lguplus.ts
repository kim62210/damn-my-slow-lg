/**
 * LG U+ 속도측정 Provider
 *
 * 측정 플로우:
 * 1. account.lguplus.com OAuth2 허브 경유 로그인
 *    - www.lguplus.com/login -> account.lguplus.com/login 리다이렉트
 *    - "U+ID" 버튼 클릭 -> /login/email 페이지
 *    - input[name="id"] / input[name="password"] 입력 -> submit
 *    - reCAPTCHA v3 (invisible) 자동 통과
 * 2. 고객지원 > 간편해결 > 인터넷 속도 측정 이동
 * 3. "최저보장속도 측정(SLA)" 버튼 클릭
 * 4. 5회 자동 측정 완료 대기 (15초 폴링, 40분 타임아웃)
 * 5. 결과 파싱 및 SLA 판정
 * 6. 감면 대상 시 안내 (전화 101)
 *
 * 주요 특징:
 * - CSS 해시 클래스 사용 금지 (Nuxt.js SPA, 빌드마다 변경됨)
 * - 다중 fallback 선택자 패턴 (배열 순회)
 * - page.evaluate() 기반 DOM 직접 검사 (폴링)
 * - 모든 주요 단계에서 스냅샷 저장
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { Config, SpeedTestResult, SpeedTestRound } from '../types';
import { getMinGuaranteedSpeed, judgeRound, judgeSLA } from '../core/sla';
import { DATA_DIR } from '../core/config';

/** LGU+ 웹사이트 URL */
const URLS = {
  login: 'https://www.lguplus.com/login',
  /** OAuth2 허브 (리다이렉트 목적지) */
  oauthHub: 'https://account.lguplus.com/login',
  /** 이메일 로그인 (U+ID 선택 후) */
  oauthEmail: 'https://account.lguplus.com/login/email',
  /** 속도측정 페이지 */
  speedTest: 'https://www.lguplus.com/support/self-troubleshoot/internet-speed-test',
};

/** 폴링 간격 (ms) */
const POLL_INTERVAL = 15_000;
/** 측정 타임아웃 (ms) - 40분 */
const MEASURE_TIMEOUT = 40 * 60 * 1000;
/** 네비게이션 타임아웃 (ms) */
const NAV_TIMEOUT = 30_000;
/** SPA 렌더링 대기 (ms) */
const SPA_SETTLE = 3_000;
/** 최대 재시도 횟수 */
const MAX_RETRIES = 2;

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
    this.browser = await chromium.launch({
      headless: this.config.headless,
    });
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
    await page.goto(URLS.login, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
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
      '[data-testid="uplusid-login"]',
    ];

    const uplusIdBtn = await findFirstVisible(page, uplusIdButtonSelectors, 8_000);
    if (uplusIdBtn) {
      console.log('[LGU+] "U+ID" 버튼 클릭');
      await uplusIdBtn.click();
      await page.waitForTimeout(SPA_SETTLE);
    } else {
      // 이미 email 로그인 페이지이거나 버튼이 없는 경우
      console.log('[LGU+] U+ID 버튼 미발견, 현재 페이지에서 로그인 시도');
    }

    // Step 3: ID/PW 입력
    console.log('[LGU+] 자격증명 입력 중...');

    // ID 필드 - 다중 fallback
    const idSelectors = [
      'input[name="id"]',
      'input[aria-label*="이메일"]',
      'input[aria-label*="휴대폰"]',
      'input[placeholder*="이메일"]',
      'input[placeholder*="아이디"]',
      'input[type="text"]:not([name="password"])',
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

    // PW 필드 - 다중 fallback
    const pwSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[aria-label*="비밀번호"]',
      'input[placeholder*="비밀번호"]',
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
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("로그인")',
      'button:has-text("로그인"):not([disabled])',
      'input[type="submit"]',
    ];

    const submitBtn = await findFirstVisible(page, submitSelectors, 5_000);
    if (!submitBtn) {
      await this.saveSnapshot('login-submit-not-found');
      throw new Error('로그인 버튼을 찾을 수 없습니다.');
    }

    await submitBtn.click();

    // 로그인 완료 대기 (SPA 전환이므로 URL 변화 또는 DOM 변화 감지)
    try {
      await page.waitForURL(
        (url) => !url.href.includes('account.lguplus.com/login'),
        { timeout: 15_000 }
      );
    } catch {
      // URL이 안 바뀌어도 로그인 실패/성공 여부는 이후 확인
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

        // 로그인 페이지로 리다이렉트되었는지 확인
        if (page.url().includes('account.lguplus.com')) {
          console.log('[LGU+] 로그인 세션 만료, 재로그인 시도');
          await this.login();
          continue;
        }

        await this.dismissPopups();

        // 프로그램 설치 요구 팝업 감지
        const installRequired = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          return bodyText.includes('프로그램 설치') ||
            bodyText.includes('ActiveX') ||
            bodyText.includes('플러그인 설치');
        });

        if (installRequired) {
          await this.saveSnapshot('install-required');
          throw new Error(
            'PC 프로그램 설치가 필요합니다. ' +
            'LGU+ 속도측정은 전용 프로그램이 필요할 수 있습니다. ' +
            '브라우저에서 직접 https://www.lguplus.com/support/self-troubleshoot/internet-speed-test 에 ' +
            '접속하여 안내에 따라 프로그램을 설치한 뒤 다시 시도하세요.'
          );
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

  /** SLA 속도측정 실행 (5회 자동 측정) */
  private async runSLAMeasurement(): Promise<SpeedTestRound[]> {
    const page = this.getPage();
    const minSpeed = getMinGuaranteedSpeed(this.config.plan.speed_mbps);

    // 회선 선택 (다회선 사용자)
    await this.selectLineIfNeeded();

    // SLA 측정 버튼 탐색 및 클릭
    console.log('[LGU+] SLA 측정 버튼 탐색 중...');
    const slaButtonSelectors = [
      'button:has-text("최저 보장 속도 측정")',
      'button:has-text("최저보장속도 측정")',
      'button:has-text("SLA")',
      'a:has-text("최저 보장 속도 측정")',
      'a:has-text("최저보장속도")',
      'a:has-text("SLA")',
      'button:has-text("최저보장")',
    ];

    let slaButton = await findFirstVisible(page, slaButtonSelectors, 10_000);

    if (!slaButton) {
      // SLA 전용 버튼이 없으면 일반 측정 버튼 시도
      console.log('[LGU+] SLA 전용 버튼 미발견, 일반 측정 버튼 탐색');
      const generalButtonSelectors = [
        'button:has-text("측정 시작")',
        'button:has-text("속도측정")',
        'button:has-text("속도 측정")',
        'button:has-text("시작")',
        'a:has-text("측정 시작")',
      ];
      slaButton = await findFirstVisible(page, generalButtonSelectors, 5_000);
    }

    if (!slaButton) {
      await this.saveSnapshot('sla-button-not-found');
      throw new Error(
        '속도측정 버튼을 찾을 수 없습니다. ' +
        '`damn-my-slow-lg calibrate` 명령으로 페이지 구조를 확인해주세요.'
      );
    }

    // 측정 시작
    console.log('[LGU+] SLA 속도 측정 시작');
    await slaButton.click();
    await page.waitForTimeout(SPA_SETTLE);
    await this.saveSnapshot('measurement-started');

    // 5회 측정 완료 대기 (page.evaluate 폴링)
    const rounds = await this.pollForResults(minSpeed);

    if (rounds.length === 0) {
      await this.saveSnapshot('measurement-timeout');
      throw new Error(
        '측정 결과를 파싱할 수 없습니다. ' +
        '40분 타임아웃 또는 페이지 구조 변경.'
      );
    }

    return rounds;
  }

  /** 회선 선택 UI 처리 (다회선 사용자) */
  private async selectLineIfNeeded(): Promise<void> {
    const page = this.getPage();

    const lineSelectors = [
      'select:has(option)',
      'label:has-text("회선")',
      'button:has-text("회선")',
      '[role="listbox"]',
    ];

    const lineUI = await findFirstVisible(page, lineSelectors, 3_000);
    if (lineUI) {
      console.log('[LGU+] 회선 선택 UI 감지, 첫 번째 회선 선택');

      // select 요소인 경우
      const tagName = await lineUI.evaluate((el) => el.tagName.toLowerCase());
      if (tagName === 'select') {
        // 첫 번째 유효 옵션 선택 (보통 현재 회선)
        await lineUI.selectOption({ index: 0 });
      } else {
        await lineUI.click();
      }

      await tryClick(page, [
        'button:has-text("확인")',
        'button:has-text("선택")',
        'button:has-text("적용")',
      ]);
      await page.waitForTimeout(2_000);
    }
  }

  /**
   * page.evaluate() 기반 측정 완료 폴링
   *
   * 15초 간격으로 DOM을 직접 검사하여 5회 라운드 결과가
   * 모두 채워졌는지 확인한다.
   */
  private async pollForResults(minSpeed: number): Promise<SpeedTestRound[]> {
    const page = this.getPage();
    const startTime = Date.now();
    let lastRoundCount = 0;

    while (Date.now() - startTime < MEASURE_TIMEOUT) {
      await page.waitForTimeout(POLL_INTERVAL);

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // page.evaluate로 DOM 직접 검사
      const parsed = await page.evaluate(() => {
        const results: Array<{ round: number; download: number; upload: number }> = [];
        const bodyText = document.body.innerText || '';

        // 패턴 1: 테이블 행에서 Mbps 값 추출
        const rows = document.querySelectorAll('table tr, [class*="round"], [class*="step"], [class*="result-row"]');
        let roundNum = 1;
        for (const row of rows) {
          const text = (row as HTMLElement).innerText || '';
          const speeds = text.match(/(\d+\.?\d*)\s*[Mm]bps/gi);
          if (speeds && speeds.length >= 1) {
            const dl = parseFloat(speeds[0].replace(/[^0-9.]/g, ''));
            const ul = speeds.length >= 2 ? parseFloat(speeds[1].replace(/[^0-9.]/g, '')) : 0;
            if (dl > 0) {
              results.push({ round: roundNum++, download: dl, upload: ul });
            }
          }
        }

        // 패턴 2: 테이블이 없으면 전체 텍스트에서 연속 Mbps 값 추출
        if (results.length === 0) {
          const allSpeeds = bodyText.match(/(\d+\.?\d*)\s*[Mm]bps/gi);
          if (allSpeeds && allSpeeds.length >= 2) {
            // 짝수개씩 download/upload 쌍으로 취급
            for (let i = 0; i < allSpeeds.length; i += 2) {
              const dl = parseFloat(allSpeeds[i].replace(/[^0-9.]/g, ''));
              const ul = i + 1 < allSpeeds.length
                ? parseFloat(allSpeeds[i + 1].replace(/[^0-9.]/g, ''))
                : 0;
              if (dl > 0) {
                results.push({ round: results.length + 1, download: dl, upload: ul });
              }
            }
          }
        }

        // 완료 키워드 감지
        const isComplete = bodyText.includes('측정 완료') ||
          bodyText.includes('결과 확인') ||
          bodyText.includes('측정이 완료') ||
          bodyText.includes('테스트 완료');

        // SLA 판정 텍스트 감지
        const slaText = bodyText.includes('미달') ? 'fail'
          : bodyText.includes('충족') ? 'pass'
          : null;

        return { results, isComplete, slaText };
      });

      const roundCount = parsed.results.length;

      if (roundCount > lastRoundCount) {
        console.log(`[LGU+] 라운드 ${roundCount}/5 완료 (${elapsed}초 경과)`);
        lastRoundCount = roundCount;
        await this.saveSnapshot(`round-${roundCount}`);
      } else {
        console.log(`[LGU+] 측정 진행 중... ${roundCount}/5 (${elapsed}초 경과)`);
      }

      // 5회 라운드 결과가 모두 채워졌거나 완료 키워드 감지
      if (roundCount >= 5 || (parsed.isComplete && roundCount > 0)) {
        console.log('[LGU+] 측정 완료 감지');
        await this.saveSnapshot('measurement-complete');

        const rounds: SpeedTestRound[] = parsed.results.map((r) => ({
          round: r.round,
          download_mbps: r.download,
          upload_mbps: r.upload,
          passed: judgeRound(r.download, minSpeed),
        }));

        return rounds;
      }
    }

    // 타임아웃 - 부분 결과라도 반환
    const finalParsed = await page.evaluate(() => {
      const results: Array<{ round: number; download: number; upload: number }> = [];
      const rows = document.querySelectorAll('table tr, [class*="round"], [class*="step"]');
      let roundNum = 1;
      for (const row of rows) {
        const text = (row as HTMLElement).innerText || '';
        const speeds = text.match(/(\d+\.?\d*)\s*[Mm]bps/gi);
        if (speeds && speeds.length >= 1) {
          const dl = parseFloat(speeds[0].replace(/[^0-9.]/g, ''));
          const ul = speeds.length >= 2 ? parseFloat(speeds[1].replace(/[^0-9.]/g, '')) : 0;
          if (dl > 0) {
            results.push({ round: roundNum++, download: dl, upload: ul });
          }
        }
      }
      return results;
    });

    if (finalParsed.length > 0) {
      console.log(`[LGU+] 타임아웃, 부분 결과 반환 (${finalParsed.length}회)`);
      return finalParsed.map((r) => ({
        round: r.round,
        download_mbps: r.download,
        upload_mbps: r.upload,
        passed: judgeRound(r.download, minSpeed),
      }));
    }

    return [];
  }

  /** HTML + 스크린샷 스냅샷 저장 */
  private async saveSnapshot(label: string): Promise<string> {
    const page = this.getPage();
    const snapshotDir = path.join(DATA_DIR, 'snapshots');

    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `lguplus-${label}-${timestamp}`;
    const htmlPath = path.join(snapshotDir, `${baseName}.html`);
    const screenshotPath = path.join(snapshotDir, `${baseName}.png`);

    try {
      const html = await page.content();
      fs.writeFileSync(htmlPath, html, 'utf-8');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[LGU+] 스냅샷: ${baseName}`);
    } catch (err) {
      console.log(`[LGU+] 스냅샷 저장 실패: ${err instanceof Error ? err.message : err}`);
    }

    return htmlPath;
  }

  /** 전체 속도측정 + SLA 판정 실행 */
  async run(dryRun = false): Promise<SpeedTestResult> {
    try {
      await this.init();
      await this.login();
      await this.navigateToSpeedTest();

      await this.saveSnapshot('before-test');

      const rounds = await this.runSLAMeasurement();

      await this.saveSnapshot('after-test');

      // SLA 판정
      const slaResult = judgeSLA(rounds);
      const totalDownload = rounds.reduce((sum, r) => sum + r.download_mbps, 0) / rounds.length;
      const totalUpload = rounds.reduce((sum, r) => sum + r.upload_mbps, 0) / rounds.length;
      const failCount = rounds.filter((r) => !r.passed).length;

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

      // SLA 미달 안내
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
      console.log('  1. "최저 보장 속도 측정(SLA)" 버튼의 선택자');
      console.log('  2. 측정 결과 테이블/행의 선택자');
      console.log('  3. 다운로드/업로드 Mbps 값의 위치');
      console.log('  4. 회선 선택 UI (다회선 사용자)');
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
}
