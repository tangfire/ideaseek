/**
 * 云原生工作流引擎：Postgres 是唯一真源。
 *
 * 三条硬规则（CLOUD_NATIVE_REFACTOR_PLAN §5）：
 *   1. 认领 = 唯一键插入（cloud_task_lease UNIQUE(task_id)），不是"先查再改"
 *   2. 提交 = 带条件的 CAS 更新 + 返回行核对
 *   3. 幂等键覆盖每个外部副作用
 *
 * 本文件只实现最小闭环需要的动词子集，不假装覆盖 WorkflowDb 的全部 80 方法。
 */
import type { BackendErrorLike, Builder, Db, QueryResult } from '../deps.ts';
import { rows } from '../deps.ts';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type RunPhase =
  | 'INIT' | 'INPUT_READY' | 'CALIBRATING' | 'PAPER_ANALYSIS' | 'DATA_READY'
  | 'PROTOCOL_PROPOSED' | 'PROTOCOL_REVIEW' | 'COMPARISON_DISCOVERY'
  | 'COMPARISON_REPRODUCTION' | 'BASELINE_VALIDATED' | 'IDEA_GENERATION'
  | 'IDEA_SCREENING' | 'EXPERIMENTING' | 'IDEA_REVIEW' | 'COMPLETED';

export type RunStatus =
  | 'created' | 'running' | 'paused' | 'blocked' | 'succeeded' | 'failed' | 'canceled';

export type TaskStatus =
  | 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'expired';

export interface CloudRun {
  id: string;
  project_id: string;
  external_run_id: string;
  status: RunStatus;
  phase_tag: string;
  question: string | null;
  summary: string | null;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
}

export interface CloudTask {
  id: string;
  run_id: string;
  external_task_id: string;
  kind: string;
  agent_role: string | null;
  status: TaskStatus;
  phase_tag: string | null;
  attempt: number;
  max_attempts: number | null;
  started_at: string | null;
  ended_at: string | null;
  error_class: string | null;
  error_summary: string | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export interface CloudEvent {
  id: string;
  run_id: string;
  seq: number;
  ts: string;
  phase_tag: string | null;
  type: string;
  summary: string;
  level: string;
  object_type: string | null;
  object_id: string | null;
}

export interface ClaimResult {
  task: CloudTask;
  leaseEpoch: number;
}

export interface EnqueueTaskInput {
  runId: string;
  kind: string;
  phaseTag: string;
  payload?: Record<string, unknown>;
  agentRole?: string;
  maxAttempts?: number;
  externalTaskId?: string;
}

export interface CommitInput {
  taskId: string;
  workerId: string;
  leaseEpoch: number;
  result?: Record<string, unknown>;
}

export interface FailInput {
  taskId: string;
  workerId: string;
  leaseEpoch: number;
  errorClass: string;
  errorSummary: string;
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

const LEASE_DURATION_MS = 5 * 60_000;

export class CloudEngine {
  constructor(
    private db: Db,
    private BackendError: BackendErrorLike,
  ) {}

  // ---- Run 生命周期 ----

  async getRun(runId: string): Promise<CloudRun | null> {
    const result = await this.db.from<CloudRun>('cloud_run').select('*').eq('id', runId).limit(1);
    return rows(result, this.BackendError)[0] ?? null;
  }

  async getProjectByExternal(externalId: string): Promise<{ id: string; owner_id: string; visibility: string; archived_at: string | null } | null> {
    const result = await this.db.from<{ id: string; owner_id: string; visibility: string; archived_at: string | null }>('cloud_project').select('id,owner_id,visibility,archived_at').eq('external_id', externalId).limit(1);
    return rows(result, this.BackendError)[0] ?? null;
  }

  async getProjectById(projectId: string): Promise<{ id: string; owner_id: string; visibility: string; archived_at: string | null } | null> {
    const result = await this.db.from<{ id: string; owner_id: string; visibility: string; archived_at: string | null }>('cloud_project').select('id,owner_id,visibility,archived_at').eq('id', projectId).limit(1);
    return rows(result, this.BackendError)[0] ?? null;
  }

  async getRunByExternal(projectId: string, externalRunId: string): Promise<CloudRun | null> {
    const result = await this.db.from<CloudRun>('cloud_run')
      .select('*')
      .eq('project_id', projectId)
      .eq('external_run_id', externalRunId)
      .limit(1);
    return rows(result, this.BackendError)[0] ?? null;
  }

  async setRunPhase(runId: string, phase: RunPhase, opts?: { status?: RunStatus; summary?: string; blockReason?: string | null }): Promise<CloudRun> {
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      phase_tag: phase,
      heartbeat_at: now,
    };
    if (opts?.status) {
      patch.status = opts.status;
      if (opts.status === 'succeeded') patch.finished_at = now;
    }
    if (opts?.summary !== undefined) patch.summary = opts.summary;
    if (opts?.blockReason !== undefined) patch.block_reason = opts.blockReason;

    const result = await this.db.from<CloudRun>('cloud_run')
      .update(patch)
      .eq('id', runId)
      .select('*');
    const updated = rows(result, this.BackendError);
    if (!updated[0]) throw new this.BackendError('run_not_found', 404);
    return updated[0];
  }

  async listActiveRuns(projectId?: string): Promise<CloudRun[]> {
    let q = this.db.from<CloudRun>('cloud_run').select('*');
    if (projectId) q = q.eq('project_id', projectId);
    const all = rows(await q, this.BackendError);
    return all.filter((r) => r.status === 'created' || r.status === 'running' || r.status === 'paused' || r.status === 'blocked');
  }

  // ---- Task 生命周期 ----

  async enqueueTask(input: EnqueueTaskInput): Promise<{ task: CloudTask; created: boolean }> {
    const externalTaskId = input.externalTaskId ?? `task-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    const existing = await this.db.from<CloudTask>('cloud_task')
      .select('*')
      .eq('run_id', input.runId)
      .eq('external_task_id', externalTaskId)
      .limit(1);
    const found = rows(existing, this.BackendError);
    if (found[0]) return { task: found[0], created: false };

    const result = await this.db.from<CloudTask>('cloud_task')
      .insert({
        run_id: input.runId,
        external_task_id: externalTaskId,
        kind: input.kind,
        agent_role: input.agentRole ?? null,
        status: 'queued',
        phase_tag: input.phaseTag,
        attempt: 0,
        max_attempts: input.maxAttempts ?? 3,
        started_at: null,
        ended_at: null,
        error_class: null,
        error_summary: null,
        payload: input.payload ?? null,
        result: null,
        artifact_count: 0,
      })
      .select('*');
    const created = rows(result, this.BackendError);
    if (!created[0]) throw new this.BackendError('write_failed', 500);
    return { task: created[0], created: true };
  }

  /**
   * 认领下一个 queued 任务。
   * 规则 1：认领 = 唯一键插入（cloud_task_lease UNIQUE(task_id)）。
   * 先找到 queued 任务，再 insertIfAbsent 到 lease 表；如果 lease 已存在说明被别人抢了。
   */
  async claimNextTask(runId: string, workerId: string): Promise<ClaimResult | null> {
    const queued = await this.db.from<CloudTask>('cloud_task')
      .select('*')
      .eq('run_id', runId)
      .eq('status', 'queued')
      .order('attempt', { ascending: true })
      .limit(1);
    const task = rows(queued, this.BackendError)[0];
    if (!task) return null;

    const now = new Date();
    const leaseEpoch = task.attempt + 1;

    const leaseResult = await this.db.from<{ task_id: string; lease_epoch: number }>('cloud_task_lease')
      .insertIfAbsent(
        {
          task_id: task.id,
          worker_id: workerId,
          lease_epoch: leaseEpoch,
          leased_at: now.toISOString(),
          expires_at: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
        },
        { onConflict: 'task_id' },
      );

    const leaseRows = rows(leaseResult, this.BackendError);
    if (!leaseRows[0]) {
      // 受管 SDK 的 insertIfAbsent 插入成功也可能不返回行（2026-11-23 线上实测：
      // lease 已落库但 data 为空，认领被误判为失败，任务永远停在 queued）。
      // 读回确认归属：lease 是自己的才算认领成功，是别人的说明竞争输了。
      const readBack = rows(
        await this.db.from<{ task_id: string; worker_id: string; lease_epoch: number }>('cloud_task_lease')
          .select('task_id,worker_id,lease_epoch')
          .eq('task_id', task.id)
          .limit(1),
        this.BackendError,
      )[0];
      if (!readBack || readBack.worker_id !== workerId || readBack.lease_epoch !== leaseEpoch) return null;
    }

    const casResult = await this.db.from<CloudTask>('cloud_task')
      .update({
        status: 'claimed',
        attempt: leaseEpoch,
        started_at: now.toISOString(),
      })
      .eq('id', task.id)
      .eq('status', 'queued')
      .select('*');

    const updated = rows(casResult, this.BackendError);
    if (!updated[0]) {
      await this.db.from('cloud_task_lease').delete().eq('task_id', task.id);
      return null;
    }

    return { task: updated[0], leaseEpoch };
  }

  /**
   * 心跳续租。返回 null 表示租约已被取代。
   */
  async heartbeat(taskId: string, workerId: string, leaseEpoch: number): Promise<{ expiresAt: string } | null> {
    const now = new Date();
    const newExpiry = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

    const result = await this.db.from<{ expires_at: string }>('cloud_task_lease')
      .update({ expires_at: newExpiry })
      .eq('task_id', taskId)
      .eq('worker_id', workerId)
      .eq('lease_epoch', leaseEpoch)
      .select('expires_at');

    const updated = rows(result, this.BackendError);
    if (!updated[0]) return null;
    return { expiresAt: updated[0].expires_at };
  }

  /**
   * 提交任务结果。
   * 规则 2：CAS 更新 + 返回行核对。
   */
  async commitTask(input: CommitInput): Promise<CloudTask> {
    const now = new Date().toISOString();

    const taskUpdate = await this.db.from<CloudTask>('cloud_task')
      .update({
        status: 'succeeded',
        ended_at: now,
        result: input.result ?? null,
      })
      .eq('id', input.taskId)
      .eq('status', 'claimed')
      .select('*');

    const updated = rows(taskUpdate, this.BackendError);
    if (!updated[0]) throw new this.BackendError('lease_expired', 409);

    await this.db.from('cloud_task_lease').delete().eq('task_id', input.taskId);

    return updated[0];
  }

  /**
   * 任务失败。如果 attempt < max_attempts，重新排队；否则标 failed。
   */
  async failTask(input: FailInput): Promise<CloudTask> {
    const now = new Date().toISOString();

    const taskResult = await this.db.from<CloudTask>('cloud_task')
      .select('*')
      .eq('id', input.taskId)
      .limit(1);
    const task = rows(taskResult, this.BackendError)[0];
    if (!task) throw new this.BackendError('task_not_found', 404);

    await this.db.from('cloud_task_lease').delete().eq('task_id', input.taskId);

    const shouldRetry = task.max_attempts != null && task.attempt < task.max_attempts;
    const newStatus: TaskStatus = shouldRetry ? 'queued' : 'failed';

    const patch: Record<string, unknown> = {
      status: newStatus,
      ended_at: shouldRetry ? null : now,
      error_class: input.errorClass,
      error_summary: input.errorSummary,
    };
    if (shouldRetry) {
      patch.started_at = null;
    }

    const result = await this.db.from<CloudTask>('cloud_task')
      .update(patch)
      .eq('id', input.taskId)
      .select('*');
    return rows(result, this.BackendError)[0]!;
  }

  async cancelTask(taskId: string): Promise<CloudTask> {
    const now = new Date().toISOString();
    await this.db.from('cloud_task_lease').delete().eq('task_id', taskId);

    const result = await this.db.from<CloudTask>('cloud_task')
      .update({ status: 'canceled', ended_at: now })
      .eq('id', taskId)
      .select('*');
    return rows(result, this.BackendError)[0]!;
  }

  async listTasks(runId: string): Promise<CloudTask[]> {
    const result = await this.db.from<CloudTask>('cloud_task')
      .select('*')
      .eq('run_id', runId)
      .order('attempt', { ascending: true });
    return rows(result, this.BackendError);
  }

  // ---- 事件 ----

  async appendEvent(input: {
    runId: string;
    type: string;
    summary: string;
    phaseTag?: string;
    objectType?: string;
    objectId?: string;
    level?: string;
  }): Promise<CloudEvent> {
    const latestSeq = await this.db.from<{ seq: number }>('cloud_run_event')
      .select('seq')
      .eq('run_id', input.runId)
      .order('seq', { ascending: false })
      .limit(1);
    const nextSeq = (rows(latestSeq, this.BackendError)[0]?.seq ?? 0) + 1;
    const now = new Date().toISOString();

    const result = await this.db.from<CloudEvent>('cloud_run_event')
      .insert({
        run_id: input.runId,
        seq: nextSeq,
        ts: now,
        phase_tag: input.phaseTag ?? null,
        object_type: input.objectType ?? null,
        object_id: input.objectId ?? null,
        actor_role: 'engine',
        type: input.type,
        summary: input.summary,
        truncated: false,
        level: input.level ?? 'info',
        artifact_refs: null,
      })
      .select('*');
    const created = rows(result, this.BackendError);
    if (!created[0]) throw new this.BackendError('write_failed', 500);
    return created[0];
  }

  async listEvents(runId: string, opts?: { limit?: number; afterSeq?: number }): Promise<CloudEvent[]> {
    let q = this.db.from<CloudEvent>('cloud_run_event')
      .select('*')
      .eq('run_id', runId);
    if (opts?.afterSeq != null) q = q.gte('seq', opts.afterSeq + 1);
    q = q.order('seq', { ascending: true });
    if (opts?.limit) q = q.limit(opts.limit);
    return rows(await q, this.BackendError);
  }

  // ---- 阶段进度 ----

  async setStageProgress(runId: string, stage: string, state: string, opts?: { gateNote?: string; blockerCode?: string }): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db.from<{ id: string; state: string }>('cloud_stage_progress')
      .select('*')
      .eq('run_id', runId)
      .eq('stage', stage)
      .limit(1);
    const found = rows(existing, this.BackendError)[0];

    if (found) {
      const patch: Record<string, unknown> = { state, entered_at: found.state !== state ? now : undefined };
      if (state === 'passed' || state === 'failed') patch.exited_at = now;
      if (opts?.gateNote !== undefined) patch.gate_note = opts.gateNote;
      if (opts?.blockerCode !== undefined) patch.blocker_code = opts.blockerCode;
      await this.db.from('cloud_stage_progress')
        .update(patch)
        .eq('id', found.id);
    } else {
      await this.db.from('cloud_stage_progress')
        .insert({
          run_id: runId,
          stage,
          state,
          stage_known: true,
          gate_note: opts?.gateNote ?? null,
          blocker_code: opts?.blockerCode ?? null,
          entered_at: now,
          exited_at: null,
        });
    }
  }

  // ---- 研究节点 ----

  async upsertResearchNode(input: {
    runId: string;
    nodeId: string;
    kind: string;
    status: string;
    title?: string;
    detail?: Record<string, unknown>;
  }): Promise<{ created: boolean }> {
    const now = new Date().toISOString();
    const existing = await this.db.from<{ id: string; status: string }>('cloud_research_node')
      .select('*')
      .eq('run_id', input.runId)
      .eq('node_id', input.nodeId)
      .limit(1);
    const found = rows(existing, this.BackendError)[0];

    if (found) {
      if (found.status === 'succeeded' && input.status !== 'succeeded') {
        return { created: false };
      }
      await this.db.from('cloud_research_node')
        .update({ status: input.status, title: input.title ?? null, detail: input.detail ?? null, updated_at: now })
        .eq('id', found.id);
      return { created: false };
    }

    await this.db.from('cloud_research_node')
      .insert({
        run_id: input.runId,
        node_id: input.nodeId,
        kind: input.kind,
        status: input.status,
        title: input.title ?? null,
        detail: input.detail ?? null,
        created_at: now,
        updated_at: now,
      });
    return { created: true };
  }

  async listResearchNodes(runId: string): Promise<Array<{ id: string; node_id: string; kind: string; status: string; title: string | null; detail: Record<string, unknown> | null }>> {
    const result = await this.db.from('cloud_research_node')
      .select('*')
      .eq('run_id', runId)
      .order('created_at', { ascending: true });
    return rows(result, this.BackendError);
  }

  // ---- Outbox（实时推送） ----

  async publishOutboxFrame(projectId: string, frameType: string, payload: Record<string, unknown>): Promise<void> {
    const latestSeq = await this.db.from<{ seq: number }>('live_outbox')
      .select('seq')
      .eq('project_id', projectId)
      .order('seq', { ascending: false })
      .limit(1);
    const nextSeq = (rows(latestSeq, this.BackendError)[0]?.seq ?? 0) + 1;

    await this.db.from('live_outbox').insert({
      project_id: projectId,
      batch_id: null,
      frame_type: frameType,
      payload,
      seq: nextSeq,
      created_at: new Date().toISOString(),
    });
  }

  // ---- 成本记录 ----

  async recordCost(input: {
    runId: string;
    kind: string;
    modelRoute: string;
    agentRole: string;
    usdMicro: number;
    tokensIn: number;
    tokensOut: number;
  }): Promise<void> {
    const externalCostId = `cost-${crypto.randomUUID().slice(0, 12)}`;
    await this.db.from('cloud_cost_entry').insert({
      run_id: input.runId,
      external_cost_id: externalCostId,
      kind: input.kind,
      model_route: input.modelRoute,
      agent_role: input.agentRole,
      usd_micro: input.usdMicro,
      tokens_in: input.tokensIn,
      tokens_out: input.tokensOut,
      ts: new Date().toISOString(),
    });
  }
}
