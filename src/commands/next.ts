import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import type { RunRecord } from '../workflow/types.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { ResearchMaterialAssessment } from '../knowledge/assessment.js';
import { buildNextAdvice, loadNextAdvice } from '../knowledge/next-advice.js';
import {
  action,
  buildHarness,
  countByStatus,
  isBlockedRun,
  jsonLine,
  resolveRun,
} from './shared.js';

export interface NextAdvice {
  stage: string;
  blockers: string[];
  done: string;
  suggestion: string;
  command: string;
  exitCode: number;
  /** Validated option set for gap branches: what agent advice may choose among. */
  candidates?: string[];
  /** Present only when stored agent advice replaced the ladder pick. */
  adviceSource?: 'agent';
  adviceRationale?: string;
}

async function liveWorkersOf(runtime: ProjectRuntime, runId: string): Promise<number> {
  const workers = await runtime.db.listWorkers(runId);
  const cutoff = runtime.clock.now() - runtime.config.runtime.leaseTtlSeconds * 3000;
  return workers.filter((worker) => worker.heartbeatAt >= cutoff).length;
}

/** Appends current runtime alerts to the advice (visibility, PROGRESS 213). */
async function withAlerts(runtime: ProjectRuntime, advice: NextAdvice): Promise<NextAdvice> {
  try {
    const { collectRuntimeAlerts } = await import('../runtime/alerts.js');
    const report = await collectRuntimeAlerts(runtime.paths.root);
    if (!report.healthy) {
      advice.blockers = [
        ...advice.blockers,
        ...report.alerts.map((alert) => 'alert:' + alert.kind + ' - ' + alert.detail),
      ];
    }
  } catch {
    // alerts are advisory - absence never breaks `next`
  }
  return advice;
}

/**
 * Guidance from the project's actual research material.
 *
 * This branch used to answer "no run yet" with `ideaseek run` — the fake-worker
 * demo pipeline — in a project holding eight papers. The guidance layer was
 * written for the Phase 0 skeleton and never learned that the real chain
 * (prepare → protocol → comparisons → ideas → experiments) exists, so the one
 * command whose job is to tell a user what to do next pointed them away from
 * their own inputs. `next` now asks the material assessment, which is
 * deterministic and needs no model call.
 *
 * Facts stay mechanical: stage, blockers, done and exit code are projections
 * of persisted state, and scripts depend on the exit codes. The judgment —
 * which open gap to tackle first and how to phrase it — is layered on top by
 * `applyAgentAdvice`: stored agent advice keyed to this assessment state,
 * built on the spot when a harness is available, ladder otherwise.
 */
export async function materialAdvice(
  runtime: ProjectRuntime,
  opts: { harness?: HarnessAdapter | null } = {},
): Promise<NextAdvice | null> {
  const { loadOrBuildAssessment } = await import('../knowledge/assessment.js');
  let assessment;
  try {
    ({ assessment } = await loadOrBuildAssessment(runtime.paths.root, {
      question: runtime.config.research.question,
    }));
  } catch {
    return null; // no material to reason about yet
  }
  const gaps = assessment.gaps ?? [];
  const blocking = gaps.filter((gap) => gap.priority === 'blocking');
  const recommended = gaps.filter((gap) => gap.priority === 'recommended');
  const stats = assessment.stats as Record<string, unknown>;
  const count = (key: string): number => Number(stats[key] ?? 0);
  const flag = (key: string): boolean => stats[key] === true;
  const nextGap = [...blocking, ...recommended][0];

  if (blocking.length > 0 && nextGap) {
    return applyAgentAdvice(
      runtime,
      {
        stage: 'MATERIAL_INCOMPLETE',
        blockers: blocking.map((gap) => `${gap.area}: ${gap.reason}`),
        done: `${count('paperCards')} PaperCard(s), ${count('slices')} slice(s), ${count('comparisons')} comparison(s)`,
        suggestion: `${nextGap.reason}${nextGap.cost ? ` (${nextGap.cost})` : ''}`,
        command: nextGap.fillIn ?? 'ideaseek assessment',
        // Exit 0: `next` succeeded at being an advisor. 2 is reserved for the
        // CLI being unable to answer at all (invalid config), because using it
        // for "this project is early" turns every young project into a script
        // failure — the blockers and stage fields already carry that news.
        exitCode: 0,
      },
      assessment,
      opts.harness,
    );
  }
  if (recommended.length > 0 && nextGap) {
    return applyAgentAdvice(
      runtime,
      {
        stage: 'MATERIAL_PARTIAL',
        blockers: [],
        done: `${count('paperCards')} PaperCard(s), ${count('slices')} slice(s), ${count('comparisons')} comparison(s)`,
        suggestion: `${nextGap.reason}${nextGap.cost ? ` (${nextGap.cost})` : ''}`,
        command: nextGap.fillIn ?? 'ideaseek assessment',
        exitCode: 0,
      },
      assessment,
      opts.harness,
    );
  }
  // Nothing blocking: walk the research chain in order and name the step that
  // has not happened yet. Each of these is a real command with real effects,
  // not the demo pipeline.
  if (typeof stats['protocolProposal'] !== 'string') {
    return {
      stage: 'PROTOCOL_MISSING',
      blockers: [],
      done: 'material assessment is sufficient',
      suggestion: '定义实验协议：指标、切分与可比性口径，后续结果才有解释框架',
      command: 'ideaseek protocol propose',
      exitCode: 0,
    };
  }
  if (count('requiredComparisons') > 0 && !flag('comparisonGateOk')) {
    return {
      stage: 'COMPARISONS_PENDING',
      blockers: [],
      done: `protocol ${String(stats['protocolProposal'])}, ${count('comparisons')} comparison(s)`,
      suggestion: `所有 required 基线需通过 gate（${count('requiredComparisons')} 个待满足）`,
      command: 'ideaseek comparison gate',
      exitCode: 0,
    };
  }
  if (count('comparisons') === 0) {
    // Nothing registered at all: the ladder used to jump straight to
    // IDEATION_NEXT claiming "comparisons ready" — a lie that let an idea
    // stage begin with no baseline in existence.
    return {
      stage: 'COMPARISONS_MISSING',
      blockers: [],
      done: `protocol ${String(stats['protocolProposal'])},0 comparison(s) registered`,
      suggestion:
        '从论文发现并注册对比方法（至少1个 required 基线）——没有基线，任何"打赢了谁"的结论都无法成立',
      command: 'ideaseek comparison discover',
      exitCode: 0,
    };
  }
  if (count('ideas') === 0) {
    return {
      stage: 'IDEATION_NEXT',
      blockers: [],
      done: `${count('paperCards')} PaperCard(s), protocol locked, comparisons ready`,
      suggestion: '从论文与协议出发生成候选 idea，再进入小规模并行验证',
      command: 'ideaseek ideate --round new',
      exitCode: 0,
    };
  }
  return {
    stage: 'MATERIAL_READY',
    blockers: [],
    done: `${count('ideas')} idea(s), ${count('ablationPlans')} ablation plan(s)`,
    suggestion: '查看缺口全貌与可运行实验',
    command: 'ideaseek assessment --detail',
    exitCode: 0,
  };
}

/**
 * The judgment layer over the gap ladder: re-rank and rephrase within the
 * ladder's own candidate set (the open gaps' fill-ins plus its pick).
 *
 * Stored advice keyed to this assessment's contextHash is used when fresh;
 * otherwise a harness builds it on the spot. A command outside the current
 * candidate set, a stale artifact, a blocked harness or invalid output all
 * leave the ladder's answer in place — stage, blockers and exit code are
 * never touched, so `next` always answers and scripts keep their contract.
 * One candidate means nothing to choose: no model call, ladder as-is.
 */
async function applyAgentAdvice(
  runtime: ProjectRuntime,
  advice: NextAdvice,
  assessment: ResearchMaterialAssessment,
  harness?: HarnessAdapter | null,
): Promise<NextAdvice> {
  const fillIns = assessment.gaps
    .filter((gap) => gap.priority === 'blocking' || gap.priority === 'recommended')
    .map((gap) => gap.fillIn.trim())
    .filter(Boolean);
  const candidates = [...new Set([advice.command, ...fillIns])].slice(0, 12);
  const base = { ...advice, candidates };
  if (candidates.length < 2) return base;
  const stored = await loadNextAdvice(runtime.paths.root, assessment.contextHash, candidates);
  const picked =
    stored ??
    (harness
      ? await buildNextAdvice({
          harness,
          root: runtime.paths.root,
          contextHash: assessment.contextHash,
          question: assessment.question,
          stats: assessment.stats as Record<string, unknown>,
          gaps: assessment.gaps,
          candidates,
          current: { command: advice.command, suggestion: advice.suggestion },
        })
      : null);
  if (!picked) return base;
  return {
    ...base,
    command: picked.command,
    suggestion: picked.suggestion,
    adviceSource: 'agent',
    adviceRationale: picked.rationale,
  };
}

/** Single source of route advice: `ideaseek next` and `ideaseek start` both ask this. */
export async function adviseNext(
  runtime: ProjectRuntime,
  run: RunRecord | null,
  opts: { harness?: HarnessAdapter | null } = {},
): Promise<NextAdvice> {
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
    const fromMaterial = await materialAdvice(runtime, opts);
    if (fromMaterial) return fromMaterial;
    const question = runtime.config.research.question;
    return {
      stage: 'INIT',
      blockers: [],
      done: `项目 ${runtime.project.name} 已初始化`,
      suggestion:
        '还没有可读输入：把论文放入 papers/、代码放入 comparisons/、数据放入 datasets/，然后让平台读一遍',
      command: question
        ? `ideaseek prepare --question "${question}"`
        : 'ideaseek prepare --question "你的研究问题"',
      exitCode: 0,
    };
  }

  const tasks = await runtime.db.listTasks(run.runId);
  const counts = countByStatus(tasks);
  const done = `论文/任务进度 ${counts.succeeded ?? 0}/${tasks.length}；失败 ${counts.failed ?? 0}；取消 ${counts.canceled ?? 0}`;

  if (run.status === 'COMPLETED') {
    // A finished run is one fact, not the whole story. The Phase 0 skeleton
    // could only say "all tasks done", which in a project sitting at the start
    // of the research chain read as "you are finished" — the first thing a
    // user asked, and the wrong answer.
    const fromMaterial = await materialAdvice(runtime, opts);
    if (fromMaterial && fromMaterial.stage !== 'MATERIAL_READY') {
      return {
        ...fromMaterial,
        stage: `RUN_DONE_${fromMaterial.stage}`,
        done: `${done}；研究链尚未走完`,
      };
    }
    return {
      stage: run.phase,
      blockers: [],
      done,
      suggestion:
        'run 已完成；研究链的下一步见 ideaseek assessment / ideaseek idea，交付见 ideaseek paper',
      command: 'ideaseek assessment --detail',
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
      suggestion:
        '查看失败任务与事件；修复后创建新 run（失败任务不自动重跑，避免把已修的问题混进旧结果）',
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
    .option(
      '--harness <kind>',
      'model harness for next-step advice: fake | dsh (default: dsh when a key is configured, else the deterministic ladder)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; harness?: string; json?: boolean }) => {
        let runtime: ProjectRuntime | null = null;
        let harness: HarnessAdapter | null = null;
        try {
          // Quiet harness resolution — deliberately NOT resolveHarnessKind:
          // a keyless `next` must stay instant and silent (no fake warning,
          // no model attempt), while a configured route gets agent advice
          // with the ladder as the always-available fallback. An explicit
          // --harness that fails to start is user error and surfaces; an
          // implicit route that fails degrades to the ladder, because `next`
          // must always answer.
          if (opts.harness) {
            harness = buildHarness(opts.harness);
            await harness.initialize();
          } else {
            const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
            const implicit = process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : null);
            if (implicit) {
              try {
                const built = buildHarness(implicit);
                await built.initialize();
                harness = built;
              } catch {
                harness = null;
              }
            }
          }
          runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          const run = await resolveRun(runtime, opts.run);
          const advice = await withAlerts(runtime, await adviseNext(runtime, run, { harness }));
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
            // Same harness as the main path: a fresh project's first `next`
            // arrives here (no run yet), and advice must build the same way.
            const advice = await withAlerts(runtime, await adviseNext(runtime, null, { harness }));
            printAdvice(advice, opts.json);
            return advice.exitCode;
          }
          throw error;
        } finally {
          await harness?.shutdown().catch(() => undefined);
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
  if (advice.adviceSource === 'agent' && advice.adviceRationale) {
    process.stdout.write(`依据：${advice.adviceRationale}\n`);
  }
  process.stdout.write(`下一条命令：${advice.command}\n`);
}
