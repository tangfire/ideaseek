/**
 * 步进驱动器：浏览器每 2s 调用一次 POST /app/step。
 *
 * 每次调用：
 *   1. 找到有活跃 run 的项目
 *   2. 认领一个 queued 任务（唯一键插入 lease）
 *   3. 执行一个最小可提交单元（≤45s）
 *   4. 提交结果（CAS 更新）
 *   5. 写 outbox 帧推送 UI
 *   6. 返回下一步状态
 *
 * 没有 queued 任务时检查当前 run 阶段，看是否需要推进到下一阶段并生成新任务。
 */
import type { BackendErrorLike, Db } from '../deps.ts';
import { CloudEngine, type CloudRun, type CloudTask, type RunPhase } from './cloud-engine.ts';
import { executeTask as executeRealTask } from './task-executors.ts';

export interface StepRequest {
  project_id?: string;
  run_id?: string;
  external_run_id?: string;
}

export interface StepResult {
  action: 'claimed' | 'advanced' | 'idle' | 'completed' | 'blocked';
  task?: CloudTask;
  run?: CloudRun;
  newPhase?: string;
  events?: Array<{ seq: number; type: string; summary: string }>;
  message: string;
}

const PHASE_ORDER = [
  'INIT', 'INPUT_READY', 'CALIBRATING', 'PAPER_ANALYSIS', 'DATA_READY',
  'PROTOCOL_PROPOSED', 'PROTOCOL_REVIEW', 'COMPARISON_DISCOVERY',
  'COMPARISON_REPRODUCTION', 'BASELINE_VALIDATED', 'IDEA_GENERATION',
  'IDEA_SCREENING', 'EXPERIMENTING', 'IDEA_REVIEW', 'COMPLETED',
] as const;

const PHASE_TASK_KIND: Record<string, string> = {
  CALIBRATING: 'calibrate',
  PAPER_ANALYSIS: 'analyze_paper',
  DATA_READY: 'prepare_data',
  PROTOCOL_PROPOSED: 'propose_protocol',
  COMPARISON_DISCOVERY: 'discover_comparison',
  COMPARISON_REPRODUCTION: 'reproduce_comparison',
  BASELINE_VALIDATED: 'validate_baseline',
  IDEA_GENERATION: 'generate_idea',
  IDEA_SCREENING: 'screen_idea',
  EXPERIMENTING: 'run_experiment',
};

export async function handleStep(
  db: Db,
  BackendError: BackendErrorLike,
  body: StepRequest,
  ownerId: string,
  anonymousOwnerId?: string | null,
  /**
   * 会话里的 Owner（null = 访客）。驱动权只认它，不认配额主体 ownerId——
   * 匿名请求的 ownerId 会被折算成系统匿名 Owner，拿它判驱动权等于又开一次演示放开。
   * 未传时沿用 ownerId（老用例把驱动者当 ownerId 传）。
   */
  sessionOwnerId?: string | null,
): Promise<StepResult> {
  const engine = new CloudEngine(db, BackendError);
  const driverId = sessionOwnerId === undefined ? ownerId : sessionOwnerId;

  const run = await resolveRun(engine, body, driverId, anonymousOwnerId);
  if (!run) return { action: 'idle', message: '没有活跃的运行' };
  if (run.status === 'succeeded' || run.phase_tag === 'COMPLETED') {
    return { action: 'completed', run, message: '运行已完成' };
  }

  const claim = await engine.claimNextTask(run.id, 'step-driver');
  if (claim) {
    const result = await executeTaskUnit(engine, run, claim.task, claim.leaseEpoch);
    return {
      action: 'claimed',
      task: result.task,
      run: result.run,
      events: result.events,
      message: `执行了 ${claim.task.kind} 任务`,
    };
  }

  // 当前阶段有重试耗尽的失败任务时阻断推进：失败不是可以静默跳过的阶段。
  const tasks = await engine.listTasks(run.id);
  const failedHere = tasks.filter((t) => t.phase_tag === run.phase_tag && t.status === 'failed');
  if (failedHere.length > 0) {
    const blockedRun = await engine.setRunPhase(run.id, run.phase_tag as RunPhase, { status: 'blocked', blockReason: 'task_failed' });
    await engine.setStageProgress(run.id, run.phase_tag, 'failed', { blockerCode: 'task_failed' });
    if (run.status !== 'blocked') {
      await engine.appendEvent({
        runId: run.id,
        type: 'run_blocked',
        summary: `阶段 ${run.phase_tag} 有 ${failedHere.length} 个任务重试耗尽，运行已阻断`,
        phaseTag: run.phase_tag,
        level: 'error',
      });
    }
    return {
      action: 'blocked',
      run: blockedRun,
      message: `阶段 ${run.phase_tag} 的 ${failedHere.map((t) => t.kind).join('、')} 任务失败（重试已耗尽）：${failedHere[0]!.error_summary ?? '未知错误'}`,
    };
  }

  const advanced = await tryAdvancePhase(engine, run);
  if (advanced) {
    return {
      action: 'advanced',
      run: advanced,
      newPhase: advanced.phase_tag,
      message: `推进到 ${advanced.phase_tag} 阶段`,
    };
  }

  return { action: 'idle', run, message: `阶段 ${run.phase_tag} 无待执行任务` };
}

/**
 * 谁能驱动一个 run。D2（已拍板）：只有 Owner 能驱动；
 * 平台演示项目（系统匿名 Owner 的 listed 项目）额外对**登录用户**开放——
 * 访客只读，避免陌生人点一下"继续运行"就烧一次 LLM。
 *
 * 判定输入是项目行本身，不是 ownerId 字符串：匿名请求的 ownerId 会被折算成
 * 系统匿名 Owner（配额要按它计账），拿它当驱动者就等于人人可驱动演示。
 */
function canDrive(
  project: { owner_id: string; visibility?: string; archived_at?: string | null },
  driverId: string | null,
  anonymousOwnerId?: string | null,
): boolean {
  // 归档项目对外不存在（D4），自然也不能再驱动。
  if (project.archived_at) return false;
  if (!driverId) return false;
  if (project.owner_id === driverId) return true;
  return Boolean(
    anonymousOwnerId && project.owner_id === anonymousOwnerId && project.visibility === 'listed',
  );
}

async function resolveRun(
  engine: CloudEngine,
  body: StepRequest,
  driverId: string | null,
  anonymousOwnerId?: string | null,
): Promise<CloudRun | null> {
  // 优先用 internal run_id
  if (body.run_id) {
    const run = await engine.getRun(body.run_id);
    if (!run) return null;
    const project = await engine.getProjectById(run.project_id);
    return project && canDrive(project, driverId, anonymousOwnerId) ? run : null;
  }

  // 支持 external_run_id（前端传递的）
  if (body.external_run_id && body.project_id) {
    const project = await engine.getProjectByExternal(body.project_id);
    if (!project || !canDrive(project, driverId, anonymousOwnerId)) return null;
    return engine.getRunByExternal(project.id, body.external_run_id);
  }

  // 用 project_id 找活跃 run（project_id 是 external_id）
  if (body.project_id) {
    const project = await engine.getProjectByExternal(body.project_id);
    if (!project || !canDrive(project, driverId, anonymousOwnerId)) return null;
    const runs = await engine.listActiveRuns(project.id);
    return runs[0] ?? null;
  }

  // 不带任何定位参数时不动任何人的运行：兜底"任意活跃 run"会让访客步进别人的项目。
  return null;
}

async function executeTaskUnit(
  engine: CloudEngine,
  run: CloudRun,
  task: CloudTask,
  leaseEpoch: number,
): Promise<{ task: CloudTask; run: CloudRun; events: Array<{ seq: number; type: string; summary: string }> }> {
  const events: Array<{ seq: number; type: string; summary: string }> = [];

  const startEvent = await engine.appendEvent({
    runId: run.id,
    type: 'task_started',
    summary: `开始执行 ${task.kind} (attempt ${task.attempt})`,
    phaseTag: run.phase_tag,
    objectType: 'task',
    objectId: task.external_task_id,
  });
  events.push({ seq: startEvent.seq, type: startEvent.type, summary: startEvent.summary });

  try {
    const taskResult = await executeRealTask({ engine, run, task });

    const committed = await engine.commitTask({
      taskId: task.id,
      workerId: 'step-driver',
      leaseEpoch,
      result: taskResult,
    });

    const commitEvent = await engine.appendEvent({
      runId: run.id,
      type: 'task_completed',
      summary: `${task.kind} 完成`,
      phaseTag: run.phase_tag,
      objectType: 'task',
      objectId: task.external_task_id,
    });
    events.push({ seq: commitEvent.seq, type: commitEvent.type, summary: commitEvent.summary });

    await engine.publishOutboxFrame(run.project_id, 'state', {
      run: { external_run_id: run.external_run_id, phase_tag: run.phase_tag, status: run.status },
      task: { external_task_id: task.external_task_id, kind: task.kind, status: 'succeeded' },
    });

    const updatedRun = await engine.getRun(run.id) ?? run;
    return { task: committed, run: updatedRun, events };
  } catch (err) {
    const errorClass = err instanceof Error ? err.name : 'unknown';
    const errorSummary = err instanceof Error ? err.message : String(err);

    const failed = await engine.failTask({
      taskId: task.id,
      workerId: 'step-driver',
      leaseEpoch,
      errorClass,
      errorSummary,
    });

    const failEvent = await engine.appendEvent({
      runId: run.id,
      type: 'task_failed',
      summary: `${task.kind} 失败: ${errorSummary}`,
      phaseTag: run.phase_tag,
      objectType: 'task',
      objectId: task.external_task_id,
      level: 'error',
    });
    events.push({ seq: failEvent.seq, type: failEvent.type, summary: failEvent.summary });

    return { task: failed, run, events };
  }
}

async function tryAdvancePhase(engine: CloudEngine, run: CloudRun): Promise<CloudRun | null> {
  const currentIdx = PHASE_ORDER.indexOf(run.phase_tag as typeof PHASE_ORDER[number]);
  if (currentIdx < 0 || currentIdx >= PHASE_ORDER.length - 1) return null;

  const nextPhase = PHASE_ORDER[currentIdx + 1];
  const taskKind = PHASE_TASK_KIND[nextPhase];

  if (!taskKind) {
    const completing = nextPhase === 'COMPLETED';
    const updated = await engine.setRunPhase(run.id, nextPhase, {
      status: completing ? 'succeeded' : undefined,
      blockReason: null,
    });
    await engine.setStageProgress(run.id, nextPhase, completing ? 'passed' : 'active');
    await engine.setStageProgress(run.id, run.phase_tag, 'passed');
    await engine.appendEvent({
      runId: run.id,
      type: 'phase_advanced',
      summary: completing ? '运行完成' : `进入 ${nextPhase} 阶段`,
      phaseTag: nextPhase,
    });
    return updated;
  }

  const tasks = await engine.listTasks(run.id);
  const hasPendingForNext = tasks.some((t) => t.phase_tag === nextPhase && (t.status === 'queued' || t.status === 'claimed'));
  if (hasPendingForNext) return null;

  // 先入队再推进：入队失败时 run 停在当前阶段，下一步重试；
  // 反过来会让失败的阶段被静默跳过（线上曾因缺列 400 而空跑全部阶段）。
  await enqueueTasksForPhase(engine, run, nextPhase, taskKind);

  const updated = await engine.setRunPhase(run.id, nextPhase, { status: 'running', blockReason: null });
  await engine.setStageProgress(run.id, nextPhase, 'active');
  await engine.setStageProgress(run.id, run.phase_tag, 'passed');

  await engine.appendEvent({
    runId: run.id,
    type: 'phase_advanced',
    summary: `进入 ${nextPhase} 阶段，已创建 ${taskKind} 任务`,
    phaseTag: nextPhase,
  });

  return updated;
}

async function enqueueTasksForPhase(
  engine: CloudEngine,
  run: CloudRun,
  phase: string,
  kind: string,
): Promise<void> {
  if (phase === 'PAPER_ANALYSIS') {
    const papers = run.question ? [run.question] : [];
    for (let i = 0; i < Math.max(papers.length, 1); i++) {
      await engine.enqueueTask({
        runId: run.id,
        kind,
        phaseTag: phase,
        payload: { paper_id: `paper-${i}`, index: i },
      });
    }
  } else if (phase === 'COMPARISON_DISCOVERY') {
    await engine.enqueueTask({
      runId: run.id,
      kind,
      phaseTag: phase,
      payload: { discovery_round: 1 },
    });
  } else if (phase === 'EXPERIMENTING') {
    // 为每个待验证的 idea 创建实验任务
    const nodes = await engine.listResearchNodes(run.id);
    const proposedIdeas = nodes.filter((n) => n.kind === 'idea' && n.status === 'proposed');
    for (const idea of proposedIdeas.slice(0, 3)) {
      await engine.enqueueTask({
        runId: run.id,
        kind,
        phaseTag: phase,
        payload: { idea_id: idea.node_id, experiment_name: `exp-${idea.node_id.slice(-8)}` },
      });
    }
    // 如果没有待验证的 idea，创建一个默认实验任务
    if (proposedIdeas.length === 0) {
      await engine.enqueueTask({
        runId: run.id,
        kind,
        phaseTag: phase,
        payload: { experiment_name: 'default-experiment' },
      });
    }
  } else if (phase === 'IDEA_GENERATION') {
    await engine.enqueueTask({
      runId: run.id,
      kind,
      phaseTag: phase,
      payload: { round: 1 },
    });
  } else {
    await engine.enqueueTask({
      runId: run.id,
      kind,
      phaseTag: phase,
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP 入口
// ---------------------------------------------------------------------------

export async function stepView(
  db: Db,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
  ownerId: string,
  anonymousOwnerId?: string | null,
  sessionOwnerId?: string | null,
): Promise<Response> {
  const req: StepRequest = {
    project_id: typeof body.project_id === 'string' ? body.project_id : undefined,
    run_id: typeof body.run_id === 'string' ? body.run_id : undefined,
    external_run_id: typeof body.external_run_id === 'string' ? body.external_run_id : undefined,
  };

  const result = await handleStep(db, BackendError, req, ownerId, anonymousOwnerId, sessionOwnerId);
  return Response.json(result);
}
