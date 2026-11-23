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
import { rows } from '../deps.ts';
import { CloudEngine, type CloudRun, type CloudTask } from './cloud-engine.ts';
import { executeTask as executeRealTask } from './task-executors.ts';

export interface StepRequest {
  project_id?: string;
  run_id?: string;
  external_run_id?: string;
}

export interface StepResult {
  action: 'claimed' | 'advanced' | 'idle' | 'completed';
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
  IDEA_GENERATION: 'generate_idea',
  IDEA_SCREENING: 'screen_idea',
};

export async function handleStep(
  db: Db,
  BackendError: BackendErrorLike,
  body: StepRequest,
  ownerId: string,
  deepseekApiKey?: string | null,
): Promise<StepResult> {
  const engine = new CloudEngine(db, BackendError);

  const run = await resolveRun(engine, BackendError, body, ownerId);
  if (!run) return { action: 'idle', message: '没有活跃的运行' };
  if (run.status === 'succeeded' || run.phase_tag === 'COMPLETED') {
    return { action: 'completed', run, message: '运行已完成' };
  }

  const claim = await engine.claimNextTask(run.id, 'step-driver');
  if (claim) {
    const result = await executeTaskUnit(engine, run, claim.task, claim.leaseEpoch, deepseekApiKey);
    return {
      action: 'claimed',
      task: result.task,
      run: result.run,
      events: result.events,
      message: `执行了 ${claim.task.kind} 任务`,
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

async function resolveRun(
  engine: CloudEngine,
  BackendError: BackendErrorLike,
  body: StepRequest,
  ownerId: string,
): Promise<CloudRun | null> {
  // 优先用 internal run_id
  if (body.run_id) return engine.getRun(body.run_id);

  // 支持 external_run_id（前端传递的）
  if (body.external_run_id && body.project_id) {
    // 将 project_id 作为 external_id 查找项目
    const project = await engine.getProjectByExternal(body.project_id);
    if (project) {
      return engine.getRunByExternal(project.id, body.external_run_id);
    }
    return null;
  }

  // 用 project_id 找活跃 run（project_id 是 external_id）
  if (body.project_id) {
    const project = await engine.getProjectByExternal(body.project_id);
    if (project) {
      const runs = await engine.listActiveRuns(project.id);
      return runs[0] ?? null;
    }
  }

  // 找任意活跃 run
  const allRuns = await engine.listActiveRuns();
  return allRuns[0] ?? null;
}

async function executeTaskUnit(
  engine: CloudEngine,
  run: CloudRun,
  task: CloudTask,
  leaseEpoch: number,
  deepseekApiKey?: string | null,
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
    const taskResult = await executeRealTask({ engine, run, task, deepseekApiKey });

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
    const updated = await engine.setRunPhase(run.id, nextPhase);
    await engine.setStageProgress(run.id, nextPhase, 'active');
    await engine.appendEvent({
      runId: run.id,
      type: 'phase_advanced',
      summary: `进入 ${nextPhase} 阶段`,
      phaseTag: nextPhase,
    });
    return updated;
  }

  const tasks = await engine.listTasks(run.id);
  const hasPendingForNext = tasks.some((t) => t.phase_tag === nextPhase && (t.status === 'queued' || t.status === 'claimed'));
  if (hasPendingForNext) return null;

  const updated = await engine.setRunPhase(run.id, nextPhase, { status: 'running' });
  await engine.setStageProgress(run.id, nextPhase, 'active');
  await engine.setStageProgress(run.id, run.phase_tag, 'passed');

  await enqueueTasksForPhase(engine, run, nextPhase, taskKind);

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
  deepseekApiKey?: string | null,
): Promise<Response> {
  const req: StepRequest = {
    project_id: typeof body.project_id === 'string' ? body.project_id : undefined,
    run_id: typeof body.run_id === 'string' ? body.run_id : undefined,
  };

  const result = await handleStep(db, BackendError, req, ownerId, deepseekApiKey);
  return Response.json(result);
}
