/**
 * CLI 명령어 정의
 * init, run, schedule, history, calibrate, status
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { loadConfig, saveConfig, configExists, getDefaultConfig, ensureDataDir, DATA_DIR, validateConfig } from './core/config';
import { createDB, resultToRecord } from './core/db';
import { notify, shouldThrottleNotify, needsRecoveryNotify } from './core/notify';
import { getMinGuaranteedSpeed } from './core/sla';
import { installScheduler, uninstallScheduler } from './core/scheduler';
import { LGUplusProvider } from './providers/lguplus';
import { acquireLock, releaseLock } from './core/lockfile';
import type { Config, HistoryRecord, NotifyPayload, SpeedTestRecord, SpeedTestResult } from './types';

let activeProvider: { cleanup(): Promise<void> } | null = null;

async function gracefulShutdown(): Promise<void> {
  console.log('\n종료 중...');
  if (activeProvider) {
    await activeProvider.cleanup().catch(() => {});
  }
  releaseLock();
  process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

const program = new Command();

program
  .name('damn-my-slow-lg')
  .description('LG U+ 인터넷 SLA 속도 미달 시 요금 감면을 도와주는 CLI 도구')
  .version('0.1.0')
  .option('-c, --config <path>', '설정 파일 경로');

/** 글로벌 --config 옵션 값을 가져오는 헬퍼 */
function getConfigPath(): string | undefined {
  return program.opts().config as string | undefined;
}

/** init - 초기 설정 */
program
  .command('init')
  .description('초기 설정 (LG U+ 계정, 요금제, 알림 설정)')
  .action(async () => {
    console.log(chalk.magenta.bold('\n  damn-my-slow-lg 초기 설정\n'));

    const existing = configExists(getConfigPath());
    if (existing) {
      const { overwrite } = await inquirer.prompt([{
        type: 'confirm',
        name: 'overwrite',
        message: '기존 설정이 있습니다. 덮어쓸까요?',
        default: false,
      }]);
      if (!overwrite) {
        console.log('설정을 유지합니다.');
        return;
      }
    }

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'id',
        message: 'LG U+ 아이디:',
        validate: (v: string) => v.length > 0 || '아이디를 입력하세요.',
      },
      {
        type: 'password',
        name: 'password',
        message: 'LG U+ 비밀번호:',
        mask: '*',
        validate: (v: string) => v.length > 0 || '비밀번호를 입력하세요.',
      },
      {
        type: 'input',
        name: 'phone',
        message: '연락처 (감면 신청 시 사용):',
        default: '',
      },
      {
        type: 'list',
        name: 'speed_mbps',
        message: '인터넷 요금제 속도:',
        choices: [
          { name: '100 Mbps', value: 100 },
          { name: '500 Mbps', value: 500 },
          { name: '1 Gbps (1000 Mbps)', value: 1000 },
          { name: '10 Gbps (10000 Mbps)', value: 10000 },
        ],
      },
      {
        type: 'input',
        name: 'discord_webhook',
        message: 'Discord Webhook URL (없으면 엔터):',
        default: '',
      },
      {
        type: 'input',
        name: 'telegram_bot_token',
        message: 'Telegram Bot Token (없으면 엔터):',
        default: '',
      },
      {
        type: 'input',
        name: 'telegram_chat_id',
        message: 'Telegram Chat ID (없으면 엔터):',
        default: '',
      },
    ]);

    const config: Config = {
      ...getDefaultConfig(),
      credentials: { id: answers.id, password: answers.password },
      phone: answers.phone,
      plan: { speed_mbps: answers.speed_mbps },
      notification: {
        discord_webhook: answers.discord_webhook,
        telegram_bot_token: answers.telegram_bot_token,
        telegram_chat_id: answers.telegram_chat_id,
      },
    };

    saveConfig(config);
    console.log(chalk.green(`\n설정 저장 완료: ${DATA_DIR}/config-lguplus.yaml`));
    console.log(chalk.yellow('\n다음 단계:'));
    console.log('  1. LG U+ 네트워크에서 실행해야 합니다.');
    console.log('  2. damn-my-slow-lg calibrate  -- DOM 선택자 확인');
    console.log('  3. damn-my-slow-lg run --dry-run  -- 테스트 실행');
    console.log('  4. damn-my-slow-lg schedule  -- 자동 스케줄 등록');
  });

/** run - 속도측정 실행 */
program
  .command('run')
  .description('속도 측정 실행')
  .option('--dry-run', '감면 안내만 하고 실제 신청은 하지 않음', false)
  .option('--no-notify', '알림 발송하지 않음')
  .option('--provider <provider>', '측정 프로바이더 (lguplus | ookla)', 'lguplus')
  .option('--sla', 'SLA 5회 측정 모드', false)
  .option('--history', '측정 없이 이력 스크래핑 모드 (최근 측정 이력만 수집)', false)
  .option('--force', '당일 제한(stop_on_complaint_success) 무시', false)
  .option('--manual-login', '브라우저에서 직접 로그인 (설정 파일 없이도 사용 가능)', false)
  .action(async (options: { dryRun: boolean; notify: boolean; provider: string; sla: boolean; history: boolean; force: boolean; manualLogin: boolean }) => {
    // --manual-login: 설정 파일 없이도 실행 가능 (기본 설정 사용)
    if (!options.manualLogin && !configExists(getConfigPath())) {
      console.error('설정 파일이 없습니다. damn-my-slow-lg init 명령으로 초기 설정을 진행해주세요.');
      console.error('또는 --manual-login 옵션으로 브라우저에서 직접 로그인할 수 있습니다.');
      process.exit(1);
    }

    if (!acquireLock()) {
      console.error('다른 인스턴스가 실행 중입니다.');
      process.exit(1);
    }

    try {
    const config = configExists(getConfigPath())
      ? loadConfig(getConfigPath())
      : getDefaultConfig();

    // --manual-login 시 요금제 속도만 필수 검증
    if (options.manualLogin) {
      if (!config.plan.speed_mbps || config.plan.speed_mbps <= 0) {
        // 대화형으로 요금제 질문
        const { speed_mbps } = await inquirer.prompt([{
          type: 'list',
          name: 'speed_mbps',
          message: '인터넷 요금제 속도를 선택하세요:',
          choices: [
            { name: '100 Mbps', value: 100 },
            { name: '500 Mbps', value: 500 },
            { name: '1 Gbps (1000 Mbps)', value: 1000 },
            { name: '10 Gbps (10000 Mbps)', value: 10000 },
          ],
        }]);
        config.plan.speed_mbps = speed_mbps;
      }
    } else {
      // 필수 필드 검증
      const validationErrors = validateConfig(config);
      if (validationErrors.length > 0) {
        console.error(chalk.red('설정 검증 실패:'));
        for (const err of validationErrors) {
          console.error(chalk.red(`  - ${err}`));
        }
        process.exit(1);
      }
    }

    // stop_on_complaint_success: 오늘 이미 감면 성공 또는 SLA fail 기록이 있으면 스킵
    if (config.schedule.stop_on_complaint_success && !options.force && !options.history) {
      const db = createDB(config.db_path);
      try {
        if (db.hasComplaintSuccessToday()) {
          console.log(chalk.yellow('오늘 이미 감면 성공 기록이 있어 측정을 건너뜁니다.'));
          return;
        }
        if (db.hasSlaFailToday()) {
          console.log(chalk.yellow('오늘 이미 SLA 미달 확인 기록이 있어 측정을 건너뜁니다.'));
          return;
        }
      } finally {
        db.close();
      }
    }

    // --history 모드: 측정 없이 이력만 스크래핑
    if (options.history) {
      console.log(chalk.magenta.bold('\n  damn-my-slow-lg 이력 스크래핑\n'));
      console.log('  LG U+ 속도측정 이력 탭에서 최근 결과를 수집합니다.');
      console.log('  (측정 프로그램 설치 불필요)\n');

      const provider = new LGUplusProvider(config, options.manualLogin);
      try {
        await (provider as any).init();
        await (provider as any).login();
        await (provider as any).navigateToSpeedTest();

        const page = (provider as any).page;
        if (!page) {
          console.log(chalk.red('브라우저 페이지를 가져올 수 없습니다.'));
          return;
        }

        // 이력 탭 클릭
        const historyTab = await page.$('text=이력') || await page.$('[data-tab="history"]') || await page.$('.tab-history');
        if (historyTab) {
          await historyTab.click();
          await page.waitForTimeout(2000);
        }

        // 이력 테이블 파싱
        const records: HistoryRecord[] = await page.$$eval('table tbody tr', (rows: Element[]) =>
          rows.map((row: Element) => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) return null;
            return {
              measured_at: cells[0]?.textContent?.trim() || '',
              latency_ms: parseFloat(cells[1]?.textContent?.trim() || '0'),
              loss_percent: parseFloat(cells[2]?.textContent?.trim() || '0'),
              upload_mbps: parseFloat(cells[3]?.textContent?.trim() || '0'),
              download_mbps: parseFloat(cells[4]?.textContent?.trim() || '0'),
            };
          }).filter(Boolean)
        );

        if (records.length === 0) {
          console.log(chalk.yellow('이력이 없습니다.'));
          return;
        }

        const table = new Table({
          head: ['측정일시', '지연(ms)', '손실(%)', '업로드(Mbps)', '다운로드(Mbps)'],
          colAligns: ['left', 'right', 'right', 'right', 'right'],
        });

        for (const r of records) {
          table.push([
            r.measured_at,
            r.latency_ms.toFixed(2),
            r.loss_percent.toFixed(1),
            r.upload_mbps.toFixed(2),
            r.download_mbps.toFixed(2),
          ]);
        }

        console.log(table.toString());
        console.log(chalk.gray(`\n  총 ${records.length}건의 이력을 수집했습니다.`));

        // JSON으로도 저장
        ensureDataDir();
        const outputPath = path.join(DATA_DIR, `history-scraped-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(records, null, 2), 'utf-8');
        console.log(chalk.green(`  이력 저장: ${outputPath}`));
      } finally {
        await (provider as any).cleanup();
      }
      return;
    }

    const providerName = options.provider.toLowerCase();
    if (providerName !== 'lguplus' && providerName !== 'ookla') {
      console.log(chalk.red(`알 수 없는 프로바이더: ${options.provider}`));
      console.log('사용 가능: lguplus (기본), ookla');
      return;
    }

    console.log(chalk.magenta.bold('\n  damn-my-slow-lg 속도 측정\n'));
    console.log(`  프로바이더: ${providerName === 'lguplus' ? 'LG U+ (공식 SLA)' : 'Ookla Speedtest CLI (참고용)'}`);
    console.log(`  계약 속도: ${config.plan.speed_mbps} Mbps`);
    console.log(`  최저보장: ${getMinGuaranteedSpeed(config.plan.speed_mbps)} Mbps (50%)`);
    if (options.sla) {
      console.log(chalk.cyan('  [SLA] 5회 연속 측정 모드'));
    }
    if (options.dryRun) {
      console.log(chalk.yellow('  [DRY RUN] 감면 안내만 합니다.'));
    }
    console.log('');

    let result: SpeedTestResult;

    if (providerName === 'ookla') {
      try {
        const { SpeedtestCliProvider } = await import('./providers/speedtest-cli');
        const ooklaProvider = new SpeedtestCliProvider(config);
        result = await ooklaProvider.run(options.dryRun);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
          console.log(chalk.red('Ookla Speedtest CLI 프로바이더를 찾을 수 없습니다.'));
          console.log(chalk.yellow('src/providers/speedtest-cli.ts 구현이 필요합니다.'));
          console.log('');
          console.log('Ookla Speedtest CLI 설치:');
          console.log('  brew install speedtest-cli  (macOS)');
          console.log('  sudo apt install speedtest-cli  (Ubuntu/Debian)');
          return;
        }
        throw err;
      }
    } else {
      const provider = new LGUplusProvider(config, options.manualLogin);
      activeProvider = provider;
      result = await provider.run(options.dryRun, options.sla);
      activeProvider = null;
    }

    // DB 저장
    const db = createDB(config.db_path);
    try {
      db.insert(resultToRecord(result, providerName));
    } finally {
      db.close();
    }

    // 결과 출력
    printResult(result, config.plan.speed_mbps);

    if (providerName === 'ookla') {
      console.log(chalk.gray('  * Ookla 결과는 참고용입니다. 공식 SLA 판정은 lguplus 프로바이더를 사용하세요.'));
      console.log('');
    }

    // 알림 발송 (에러 연속 시 throttle 적용)
    if (options.notify && (config.notification.discord_webhook || config.notification.telegram_bot_token)) {
      const recovery = needsRecoveryNotify();
      const throttled = shouldThrottleNotify(result);

      if (throttled) {
        console.log(chalk.gray('동일 에러 반복 -- 알림 throttle (24시간 내 재알림 생략)'));
      } else {
        const payload: NotifyPayload = {
          title: recovery && result.sla_result !== 'unknown'
            ? `[복구됨] ${providerName === 'ookla' ? '[Ookla] ' : ''}LG U+ 속도 측정 결과`
            : `${providerName === 'ookla' ? '[Ookla] ' : ''}LG U+ 속도 측정 결과`,
          result,
          plan_speed: config.plan.speed_mbps,
          min_guaranteed_speed: getMinGuaranteedSpeed(config.plan.speed_mbps),
          timestamp: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
        };
        await notify(config.notification, payload);
        console.log(chalk.gray('알림 발송 완료'));
      }
    }
    } finally {
      activeProvider = null;
      releaseLock();
    }
  });

/** schedule - 스케줄러 등록/해제 */
program
  .command('schedule')
  .description('자동 측정 스케줄 등록/해제')
  .option('--uninstall', '스케줄 해제')
  .action(async (options: { uninstall: boolean }) => {
    if (options.uninstall) {
      uninstallScheduler();
      console.log(chalk.green('스케줄 해제 완료'));
      return;
    }

    if (!configExists(getConfigPath())) {
      console.error('설정 파일이 없습니다. damn-my-slow-lg init 명령으로 초기 설정을 진행해주세요.');
      process.exit(1);
    }
    const config = loadConfig(getConfigPath());
    const result = installScheduler(config.schedule);
    console.log(chalk.green(`스케줄 등록 완료: ${result}`));
    console.log(`  시작 시각: ${config.schedule.time}`);
    console.log(`  간격: ${config.schedule.retry_interval_minutes}분`);
    console.log(`  최대 횟수: ${config.schedule.max_attempts}회/일`);
  });

/** history - 측정 이력 조회 */
program
  .command('history')
  .description('측정 이력 조회')
  .option('-n, --limit <number>', '표시할 레코드 수', '10')
  .option('--today', '오늘 기록만 표시')
  .option('--provider <provider>', '특정 프로바이더 기록만 표시 (lguplus | ookla)')
  .action((options: { limit: string; today: boolean; provider?: string }) => {
    if (!configExists(getConfigPath())) {
      console.error('설정 파일이 없습니다. damn-my-slow-lg init 명령으로 초기 설정을 진행해주세요.');
      process.exit(1);
    }
    const config = loadConfig(getConfigPath());
    const db = createDB(config.db_path);

    let records: SpeedTestRecord[];
    try {
      if (options.today) {
        records = db.getTodayRecords();
      } else if (options.provider) {
        records = db.getRecentByProvider(parseInt(options.limit, 10), options.provider.toLowerCase());
      } else {
        records = db.getRecent(parseInt(options.limit, 10));
      }
    } finally {
      db.close();
    }

    if (records.length === 0) {
      console.log(chalk.yellow('측정 기록이 없습니다.'));
      return;
    }

    const table = new Table({
      head: ['일시', '프로바이더', '다운(Mbps)', '업(Mbps)', 'SLA', '감면'],
      colAligns: ['left', 'left', 'right', 'right', 'center', 'center'],
    });

    for (const r of records) {
      const date = new Date(r.tested_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const slaColor = r.sla_result === 'pass' ? chalk.green : r.sla_result === 'fail' ? chalk.red : chalk.yellow;
      const providerLabel = r.isp === 'ookla' ? chalk.cyan('ookla') : chalk.blue('lguplus');

      table.push([
        date,
        providerLabel,
        r.download_mbps.toFixed(1),
        r.upload_mbps.toFixed(1),
        slaColor(r.sla_result),
        r.complaint_result,
      ]);
    }

    console.log(table.toString());
  });

/** calibrate - DOM 선택자 확인 (강화) */
program
  .command('calibrate')
  .description('LG U+ 속도측정 페이지 DOM 구조 자동 탐지 및 확인')
  .option('--dump-dom', '현재 페이지 DOM 구조를 파일로 덤프')
  .action(async (options: { dumpDom: boolean }) => {
    if (!configExists(getConfigPath())) {
      console.error('설정 파일이 없습니다. damn-my-slow-lg init 명령으로 초기 설정을 진행해주세요.');
      process.exit(1);
    }
    const config = loadConfig(getConfigPath());
    const provider = new LGUplusProvider(config);

    console.log(chalk.magenta.bold('\n  damn-my-slow-lg 캘리브레이션\n'));

    // headless=false로 강제 설정
    const origHeadless = config.headless;
    config.headless = false;

    const calibrateProvider = new LGUplusProvider(config);

    try {
      // init + login + navigate는 provider 내부에서 처리
      // calibrate 메서드 호출 대신, 직접 DOM 분석 수행
      await (calibrateProvider as any).init();
      await (calibrateProvider as any).login();
      await (calibrateProvider as any).navigateToSpeedTest();

      const page = (calibrateProvider as any).page;
      if (!page) {
        console.log(chalk.red('브라우저 페이지를 가져올 수 없습니다.'));
        return;
      }

      console.log(`  현재 URL: ${page.url()}`);
      console.log('');

      // DOM 요소 자동 탐지
      console.log(chalk.bold('--- DOM 요소 탐지 ---'));
      console.log('');

      // 1. 모든 button 요소
      const buttons = await page.$$eval('button', (els: Element[]) =>
        els.map((el: Element) => ({
          text: (el as HTMLElement).innerText?.trim().slice(0, 80) || '',
          id: el.id || '',
          className: el.className?.toString().slice(0, 100) || '',
          type: el.getAttribute('type') || '',
        })).filter((b: { text: string }) => b.text.length > 0)
      );

      console.log(chalk.cyan(`  [Button] ${buttons.length}개 발견`));
      for (const btn of buttons.slice(0, 30)) {
        const selector = btn.id ? `#${btn.id}` : btn.className ? `.${btn.className.split(' ')[0]}` : 'button';
        console.log(`    "${btn.text}" -> ${selector}`);
      }
      console.log('');

      // 2. 모든 input 요소
      const inputs = await page.$$eval('input', (els: Element[]) =>
        els.map((el: Element) => ({
          name: el.getAttribute('name') || '',
          type: el.getAttribute('type') || 'text',
          placeholder: el.getAttribute('placeholder') || '',
          id: el.id || '',
        }))
      );

      console.log(chalk.cyan(`  [Input] ${inputs.length}개 발견`));
      for (const inp of inputs.slice(0, 20)) {
        console.log(`    name="${inp.name}" type="${inp.type}" placeholder="${inp.placeholder}" id="${inp.id}"`);
      }
      console.log('');

      // 3. 테이블/리스트 구조
      const tables = await page.$$eval('table', (els: Element[]) =>
        els.map((el: Element) => ({
          id: el.id || '',
          className: el.className?.toString().slice(0, 100) || '',
          rows: (el as HTMLTableElement).rows?.length || 0,
        }))
      );

      console.log(chalk.cyan(`  [Table] ${tables.length}개 발견`));
      for (const tbl of tables) {
        console.log(`    id="${tbl.id}" class="${tbl.className}" rows=${tbl.rows}`);
      }
      console.log('');

      // 4. 주요 링크 (a 태그)
      const links = await page.$$eval('a[href]', (els: Element[]) =>
        els.map((el: Element) => ({
          text: (el as HTMLElement).innerText?.trim().slice(0, 60) || '',
          href: el.getAttribute('href') || '',
        })).filter((l: { text: string }) => l.text.length > 0)
      );

      console.log(chalk.cyan(`  [Link] ${links.length}개 발견`));
      for (const link of links.slice(0, 20)) {
        console.log(`    "${link.text}" -> ${link.href}`);
      }
      console.log('');

      // calibrate 결과 저장
      const calibrateResult = {
        url: page.url(),
        timestamp: new Date().toISOString(),
        buttons,
        inputs,
        tables,
        links: links.slice(0, 50),
      };

      ensureDataDir();
      const outputPath = path.join(DATA_DIR, 'calibrate-lguplus.json');
      fs.writeFileSync(outputPath, JSON.stringify(calibrateResult, null, 2), 'utf-8');
      console.log(chalk.green(`탐지 결과 저장: ${outputPath}`));

      // --dump-dom: 전체 HTML 덤프
      if (options.dumpDom) {
        const html = await page.content();
        const dumpPath = path.join(DATA_DIR, `calibrate-dom-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
        fs.writeFileSync(dumpPath, html, 'utf-8');
        console.log(chalk.green(`DOM 덤프 저장: ${dumpPath}`));
      }

      // 브라우저 열어두기
      console.log('');
      console.log(chalk.yellow('브라우저에서 DevTools(F12)를 열어 추가 확인할 수 있습니다.'));
      console.log(chalk.yellow('브라우저를 닫으면 캘리브레이션이 종료됩니다.'));
      await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
    } finally {
      config.headless = origHeadless;
      await (calibrateProvider as any).cleanup();
    }
  });

/** status - 현재 상태 요약 */
program
  .command('status')
  .description('설정, DB, 스케줄러, 도구 설치 상태 확인')
  .action(() => {
    console.log(chalk.magenta.bold('\n  damn-my-slow-lg 상태\n'));

    // 1. 설정 파일
    const hasConfig = configExists(getConfigPath());
    console.log(chalk.bold('  [설정]'));
    if (hasConfig) {
      console.log(chalk.green(`    설정 파일: ${getConfigPath() || `${DATA_DIR}/config-lguplus.yaml`}`));
      const config = loadConfig(getConfigPath());
      console.log(`    계약 속도: ${config.plan.speed_mbps} Mbps`);
      console.log(`    최저보장: ${getMinGuaranteedSpeed(config.plan.speed_mbps)} Mbps`);
      console.log(`    알림 - Discord: ${config.notification.discord_webhook ? 'ON' : 'OFF'}`);
      console.log(`    알림 - Telegram: ${config.notification.telegram_bot_token ? 'ON' : 'OFF'}`);
    } else {
      console.log(chalk.yellow('    설정 파일 없음. `damn-my-slow-lg init` 실행 필요'));
    }
    console.log('');

    // 2. DB 상태
    console.log(chalk.bold('  [DB]'));
    if (hasConfig) {
      const config = loadConfig(getConfigPath());
      const db = createDB(config.db_path);
      try {
        const totalCount = db.count();
        console.log(`    총 레코드: ${totalCount}건`);

        if (totalCount > 0) {
          const recent = db.getRecent(1);
          if (recent.length > 0) {
            const last = recent[0];
            const date = new Date(last.tested_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
            const slaColor = last.sla_result === 'pass' ? chalk.green : last.sla_result === 'fail' ? chalk.red : chalk.yellow;
            console.log(`    최근 측정: ${date}`);
            console.log(`    결과: ${last.download_mbps.toFixed(1)} Mbps (DL) / ${last.upload_mbps.toFixed(1)} Mbps (UL) / SLA: ${slaColor(last.sla_result)}`);
            console.log(`    프로바이더: ${last.isp}`);
          }

          const todayRecords = db.getTodayRecords();
          console.log(`    오늘 측정: ${todayRecords.length}건`);
        }
      } finally {
        db.close();
      }
    } else {
      console.log(chalk.yellow('    설정 필요'));
    }
    console.log('');

    // 3. 스케줄러 상태
    console.log(chalk.bold('  [스케줄러]'));
    const platform = process.platform;
    if (platform === 'darwin') {
      const plistPath = path.join(
        process.env.HOME || '',
        'Library', 'LaunchAgents', 'com.damn-my-slow-lg.scheduler.plist'
      );
      if (fs.existsSync(plistPath)) {
        console.log(chalk.green('    launchd 등록됨'));
        try {
          const listOutput = execSync('launchctl list | grep damn-my-slow', { encoding: 'utf-8' });
          if (listOutput.trim()) {
            console.log(`    ${listOutput.trim()}`);
          }
        } catch {
          console.log(chalk.yellow('    launchd에 로드되지 않은 상태'));
        }
      } else {
        console.log(chalk.yellow('    등록 안됨. `damn-my-slow-lg schedule` 실행 필요'));
      }
    } else {
      try {
        const crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
        if (crontab.includes('damn-my-slow-lg')) {
          console.log(chalk.green('    crontab 등록됨'));
        } else {
          console.log(chalk.yellow('    등록 안됨'));
        }
      } catch {
        console.log(chalk.yellow('    등록 안됨'));
      }
    }
    console.log('');

    // 4. 외부 도구 설치 여부
    console.log(chalk.bold('  [외부 도구]'));

    // Playwright
    try {
      require.resolve('playwright');
      console.log(chalk.green('    Playwright: 설치됨'));
    } catch {
      console.log(chalk.red('    Playwright: 미설치'));
    }

    // Ookla Speedtest CLI
    try {
      const speedtestVersion = execSync('speedtest --version 2>/dev/null', { encoding: 'utf-8' }).trim();
      console.log(chalk.green(`    Ookla Speedtest CLI: ${speedtestVersion.split('\n')[0]}`));
    } catch {
      try {
        execSync('speedtest-cli --version 2>/dev/null', { encoding: 'utf-8' });
        console.log(chalk.green('    Ookla Speedtest CLI: 설치됨 (speedtest-cli)'));
      } catch {
        console.log(chalk.yellow('    Ookla Speedtest CLI: 미설치'));
        console.log(chalk.gray('      brew install speedtest-cli  (macOS)'));
      }
    }

    console.log('');

    // 5. calibrate 결과
    const calibratePath = path.join(DATA_DIR, 'calibrate-lguplus.json');
    if (fs.existsSync(calibratePath)) {
      const stat = fs.statSync(calibratePath);
      const date = stat.mtime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      console.log(chalk.bold('  [캘리브레이션]'));
      console.log(chalk.green(`    마지막 실행: ${date}`));
    }

    console.log('');
  });

/** report - 통계 요약 */
program
  .command('report')
  .description('측정 통계 요약 보고서')
  .option('--days <n>', '조회 기간 (일)', '30')
  .action((options: { days: string }) => {
    if (!configExists(getConfigPath())) {
      console.error('설정 파일이 없습니다. damn-my-slow-lg init 명령으로 초기 설정을 진행해주세요.');
      process.exit(1);
    }
    const config = loadConfig(getConfigPath());
    const db = createDB(config.db_path);
    const days = parseInt(options.days, 10) || 30;

    try {
      const sinceDate = new Date(Date.now() - days * 86400000).toISOString();
      const records = db.getRecordsSince(sinceDate);

      if (records.length === 0) {
        console.log(chalk.yellow(`최근 ${days}일간 측정 기록이 없습니다.`));
        return;
      }

      const totalCount = records.length;
      const passCount = records.filter(r => r.sla_result === 'pass').length;
      const failCount = records.filter(r => r.sla_result === 'fail').length;
      const unknownCount = records.filter(r => r.sla_result !== 'pass' && r.sla_result !== 'fail').length;

      const avgDl = records.reduce((sum, r) => sum + r.download_mbps, 0) / totalCount;
      const avgUl = records.reduce((sum, r) => sum + r.upload_mbps, 0) / totalCount;

      // 감면 대상일 수: 날짜별로 SLA fail이 1건 이상인 날 카운트
      const failDays = new Set(
        records.filter(r => r.sla_result === 'fail').map(r => r.tested_at.slice(0, 10))
      ).size;

      console.log(chalk.magenta.bold(`\n  damn-my-slow-lg 통계 보고서 (최근 ${days}일)\n`));

      const table = new Table({
        head: ['항목', '값'],
        colAligns: ['left', 'right'],
      });

      table.push(
        ['총 측정 횟수', `${totalCount}회`],
        ['PASS', `${passCount}회 (${(passCount / totalCount * 100).toFixed(1)}%)`],
        ['FAIL', `${failCount}회 (${(failCount / totalCount * 100).toFixed(1)}%)`],
        ['UNKNOWN', `${unknownCount}회`],
        ['평균 다운로드', `${avgDl.toFixed(1)} Mbps`],
        ['평균 업로드', `${avgUl.toFixed(1)} Mbps`],
        ['감면 대상일 수', `${failDays}일`],
      );

      console.log(table.toString());
      console.log('');
    } finally {
      db.close();
    }
  });

/** 결과 출력 헬퍼 */
function printResult(result: SpeedTestResult, planSpeed: number): void {
  const minSpeed = getMinGuaranteedSpeed(planSpeed);

  console.log('');
  console.log(chalk.bold('--- 측정 결과 ---'));
  console.log(`  다운로드: ${result.download_mbps.toFixed(1)} Mbps`);
  console.log(`  업로드:   ${result.upload_mbps.toFixed(1)} Mbps`);

  if (result.raw_data.rounds.length > 0) {
    console.log('');
    console.log(`  라운드별 결과 (최저보장: ${minSpeed} Mbps):`);
    for (const r of result.raw_data.rounds) {
      const icon = r.passed ? chalk.green('PASS') : chalk.red('FAIL');
      console.log(`    ${r.round}회차: ${r.download_mbps.toFixed(1)} Mbps [${icon}]`);
    }
  }

  console.log('');
  const slaIcon = result.sla_result === 'pass' ? chalk.green.bold('PASS')
    : result.sla_result === 'fail' ? chalk.red.bold('FAIL')
    : chalk.yellow.bold('UNKNOWN');
  console.log(`  SLA 판정: ${slaIcon} (${result.raw_data.fail}/${result.raw_data.total} 미달)`);

  if (result.sla_result === 'fail') {
    console.log('');
    console.log(chalk.red.bold('  >>> 101 (LGU+ 고객센터)에 전화하여 요금 감면을 신청하세요!'));
  }

  if (result.error) {
    console.log(chalk.red(`\n  오류: ${result.error}`));
  }
  console.log('');
}

export { program };
