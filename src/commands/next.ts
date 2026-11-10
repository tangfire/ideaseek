import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import type { RunRecord } from '../workflow/types.js';
import { action, countByStatus, isBlockedRun, jsonLine, resolveRun } from './shared.js';

interface NextAdvice {
  stage: string;
  blockers: string[];
  done: string;
  suggestion: string;
  command: string;
  exitCode: number;
}

async function liveWorkersOf(runtime: ProjectRuntime, runId: string): Promise<number> {
  const workers = await runtime.db.listWorkers(runId);
  const cutoff = runtime.clock.now() - runtime.config.runtime.leaseTtlSeconds * 3000;
  return workers.filter((worker) => worker.heartbeatAt >= cutoff).length;
}

async function advise(runtime: ProjectRuntime, run: RunRecord | null): Promise<NextAdvice> {
  if (runtime.configLoad.errors.length > 0) {
    return {
      stage: 'CONFIG_INVALID',
      blockers: runtime.configLoad.errors,
      done: `项目 ${runtime.project.name} 已初始化`,
      suggestion: 'research.yaml 有阻塞问题，run/worker 已拒绝启动；逐项修复',
      command: 'ideaseek config explain',
      exitCode: 2,
    };
  }
  if (!run) {
    const question = runtime.config.research.question;
    return {
      stage: 'INIT',
      blockers: [],
      done: `项目 ${runtime.project.name} 已初始化`,
      suggestion: '创建第一个工作流 run（demo 管线：ingest → analyze → report）',
      command: question
        ? `ideaseek run --question "${question}"`
        : 'ideaseek run --question "你的研究问题"',
      exitCode: 0,
    };
  }

  const tasks = await runtime.db.listTasks(run.runId);
  const counts = countByStatus(tasks);
  const done = `论文/任务进度 ${counts.succeeded ?? 0}/${tasks.length}；失败 ${counts.failed ?? 0}；取消 ${counts.canceled ?? 0}`;

  if (run.status === 'COMPLETED') {
    return {
      stage: run.phase,
      blockers: [],
      done,
      suggestion: '所有任务已完成；查看产物与事件回放',
      command: 'ideaseek status --detail',
      exitCode: 0,
    };
  }
  if (run.status === 'FAILED') {
    const failed = tasks.find((task) => task.status === 'failed');
    return {
      stage: run.phase,
      blockers: failed
        ? [`${failed.type} ${failed.error?.code ?? 'FAILED'}: ${failed.error?.message ?? ''}`]
        : ['run FAILED'],
      done,
      suggestion: '查看失败任务与事件；修复后创建新 run（Phase 0 不自动重跑失败任务）',
      command: 'ideaseek status --detail',
      exitCode: 1,
    };
  }
  if (run.status === 'CANCELED') {
    return {
      stage: run.phase,
      blockers: [],
      done,
      suggestion: 'run 已取消，已提交产物保留；可创建新 run',
      command: 'ideaseek run --question "..."',
      exitCode: 4,
    };
  }
  if (isBlockedRun(run.status)) {
    return {
      stage: run.phase,
      blockers: [`${run.status}${run.blockReason ? `: ${run.blockReason}` : ''}`],
      done,
      suggestion: '外部条件（额度/凭据/网络）已恢复后从 checkpoint 继续，不重做成功任务',
      command: 'ideaseek continue',
      exitCode: 2,
    };
  }
  if (run.status === 'PAUSED') {
    return {
      stage: run.phase,
      blockers: [],
      done,
      suggestion: 'run 已暂停；恢复后从排队任务继续',
      command: 'ideaseek resume',
      exitCode: 3,
    };
  }

  // RUNNING
  const live = await liveWorkersOf(runtime, run.runId);
  const claimable = (counts.queued ?? 0) + (counts.leased ?? 0) + (counts.running ?? 0);
  if (live === 0 && claimable > 0) {
    return {
      stage: run.phase,
      blockers: ['没有活动的 worker'],
      done,
      suggestion: '恢复执行（前台内联 worker）',
      command: 'ideaseek run',
      exitCode: 3,
    };
  }
  if (live === 0 && claimable === 0) {
    return {
      stage: run.phase,
      blockers: ['没有可领取的任务'],
      done,
      suggestion: '检查任务状态',
      command: 'ideaseek status --detail',
      exitCode: 3,
    };
  }
  return {
    stage: run.phase,
    blockers: [],
    done,
    suggestion: `worker 正在执行（活动 ${live}）；实时进度用 status 查看`,
    command: 'ideaseek status --detail',
    exitCode: 3,
  };
}

export function registerNextCommand(program: Command): void {
  program
    .command('next')
    .description('state-aware suggestion for the next command; never starts expensive work')
    .option('--run <runId>', 'specific run id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; json?: boolean }) => {
        let runtime: ProjectRuntime | null = null;
        try {
          runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          const run = await resolveRun(runtime, opts.run);
          const advice = await advise(runtime, run);
          printAdvice(advice, opts.json);
          return advice.exitCode;
        } catch (error) {
          if (error instanceof IdeaseekError && error.code === 'NOT_INITIALIZED') {
            const advice: NextAdvice = {
              stage: 'UNINITIALIZED',
              blockers: ['当前目录不是 IdeaSeek 项目'],
              done: '—',
              suggestion: '初始化项目目录、配置模板和工作流数据库',
              command: 'ideaseek init',
              exitCode: 2,
            };
            printAdvice(advice, opts.json);
            return advice.exitCode;
          }
          if (
            error instanceof IdeaseekError &&
            error.code === 'RUN_NOT_FOUND' &&
            !opts.run &&
            runtime
          ) {
            const advice = await advise(runtime, null);
            printAdvice(advice, opts.json);
            return advice.exitCode;
          }
          throw error;
        } finally {
          await runtime?.close();
        }
      }),
    );
}

function printAdvice(advice: NextAdvice, json?: boolean): void {
  if (json) {
    process.stdout.write(jsonLine(advice));
    return;
  }
  process.stdout.write(`当前阶段：${advice.stage}\n`);
  if (advice.blockers.length > 0) {
    process.stdout.write(`阻塞：${advice.blockers.join('；')}\n`);
  }
  process.stdout.write(`已完成：${advice.done}\n`);
  process.stdout.write(`建议：${advice.suggestion}\n`);
  process.stdout.write(`下一条命令：${advice.command}\n`);
}
