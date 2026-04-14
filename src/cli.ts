/**
 * CLI 명령어 정의
 * init, run, schedule, history, calibrate
 */

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { loadConfig, saveConfig, configExists, getDefaultConfig, ensureDataDir, DATA_DIR } from './core/config';
import { createDB, resultToRecord } from './core/db';
import { notify } from './core/notify';
import { getMinGuaranteedSpeed } from './core/sla';
import { installScheduler, uninstallScheduler } from './core/scheduler';
import { LGUplusProvider } from './providers/lguplus';
import type { Config, NotifyPayload, SpeedTestRecord } from './types';

const program = new Command();

program
  .name('damn-my-slow-lg')
  .description('LG U+ 인터넷 SLA 속도 미달 시 요금 감면을 도와주는 CLI 도구')
  .version('0.1.0');

/** init - 초기 설정 */
program
  .command('init')
  .description('초기 설정 (LG U+ 계정, 요금제, 알림 설정)')
  .action(async () => {
    console.log(chalk.magenta.bold('\n  damn-my-slow-lg 초기 설정\n'));

    const existing = configExists();
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
  .action(async (options: { dryRun: boolean; notify: boolean }) => {
    const config = loadConfig();
    const provider = new LGUplusProvider(config);

    console.log(chalk.magenta.bold('\n  damn-my-slow-lg 속도 측정\n'));
    console.log(`  계약 속도: ${config.plan.speed_mbps} Mbps`);
    console.log(`  최저보장: ${getMinGuaranteedSpeed(config.plan.speed_mbps)} Mbps (50%)`);
    if (options.dryRun) {
      console.log(chalk.yellow('  [DRY RUN] 감면 안내만 합니다.'));
    }
    console.log('');

    const result = await provider.run(options.dryRun);

    // DB 저장
    const db = createDB(config.db_path);
    try {
      db.insert(resultToRecord(result));
    } finally {
      db.close();
    }

    // 결과 출력
    printResult(result, config.plan.speed_mbps);

    // 알림 발송
    if (options.notify && (config.notification.discord_webhook || config.notification.telegram_bot_token)) {
      const payload: NotifyPayload = {
        title: 'LG U+ 속도 측정 결과',
        result,
        plan_speed: config.plan.speed_mbps,
        min_guaranteed_speed: getMinGuaranteedSpeed(config.plan.speed_mbps),
        timestamp: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      };
      await notify(config.notification, payload);
      console.log(chalk.gray('알림 발송 완료'));
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

    const config = loadConfig();
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
  .action((options: { limit: string; today: boolean }) => {
    const config = loadConfig();
    const db = createDB(config.db_path);

    let records: SpeedTestRecord[];
    try {
      records = options.today
        ? db.getTodayRecords()
        : db.getRecent(parseInt(options.limit, 10));
    } finally {
      db.close();
    }

    if (records.length === 0) {
      console.log(chalk.yellow('측정 기록이 없습니다.'));
      return;
    }

    const table = new Table({
      head: ['일시', '다운(Mbps)', '업(Mbps)', 'SLA', '감면'],
      colAligns: ['left', 'right', 'right', 'center', 'center'],
    });

    for (const r of records) {
      const date = new Date(r.tested_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const slaColor = r.sla_result === 'pass' ? chalk.green : r.sla_result === 'fail' ? chalk.red : chalk.yellow;

      table.push([
        date,
        r.download_mbps.toFixed(1),
        r.upload_mbps.toFixed(1),
        slaColor(r.sla_result),
        r.complaint_result,
      ]);
    }

    console.log(table.toString());
  });

/** calibrate - DOM 선택자 확인 */
program
  .command('calibrate')
  .description('LG U+ 속도측정 페이지 DOM 구조 확인 (headless=false)')
  .action(async () => {
    const config = loadConfig();
    const provider = new LGUplusProvider(config);
    await provider.calibrate();
  });

/** 결과 출력 헬퍼 */
function printResult(result: import('./types').SpeedTestResult, planSpeed: number): void {
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
