/**
 * 投影写入路径 —— 云端库里**唯一**的写入口。
 *
 * M1 只实装 runs / stages / events 三类：spike 的通过标准是"一条伪造投影推到
 * 云端库、浏览器 hash 深链能读到"，这三类就是那条链的最小闭环。其余集合
 * **显式 501 拒绝**，不是"先收下再说"——收下一批却丢掉 14 类实体，正是要杜绝的
 * 那种静默降级（REQUIREMENTS.md §3.2 的"省略集合不等于删除"在这里的镜像）。
 *
 * 幂等（NFR-06）分两层：批级靠 `cloud_sync_batch.external_batch_id` 的全局唯一键
 * （重放同一批 → 直接返回 replay，不再动实体表）；实体级靠各表的
 * `(run_id, external_*_id)` 唯一键做 upsert。
 */
import type { BatchEnvelope } from './contract.ts';
import { ContractError, isSafePathHint, isSha256, hasCredentialUrl } from './contract.ts';
import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';
import type { SyncPrincipal } from './token.ts';

/** M1 已实装的集合；M6 新增 approvals/costs/egress。未列出的会被拒绝而不是忽略。 */
const IMPLEMENTED = ['runs', 'stages', 'events', 'approvals', 'costs', 'egress'] as const;

function present(batch: BatchEnvelope): string[] {
  return Object.entries(batch.entities)
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    .map(([name]) => name);
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractError(`时间戳必须是 epoch 毫秒整数，收到 ${typeof value}`);
  }
  return new Date(value).toISOString();
}

function text(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ContractError(`/${field} 必须是字符串`);
  if (value.length > max) throw new ContractError(`/${field} 超过 ${max} 字符上限（NFR-03）`);
  return value;
}

function requiredText(value: unknown, field: string, max: number): string {
  const out = text(value, field, max);
  if (out === null || out === '') throw new ContractError(`/${field} 不得为空`);
  return out;
}

interface ProjectRow {
  id: string;
  visibility: string;
  title: string;
}

/**
 * 项目的 upsert。**visibility 永远不接受批次里的值**：可见性是 Owner 在界面上的
 * 决定，若投影器能顺手改写它，本地一条 bug 就能把私有项目推到公开列表。
 * 契约里允许带 visibility 是为了让投影可自证，落库时这里只读不写。
 */
async function resolveProject(
  db: Db,
  principal: SyncPrincipal,
  batch: BatchEnvelope,
  BackendError: BackendErrorLike,
): Promise<{ row: ProjectRow; created: boolean }> {
  const externalId = requiredText(batch.project.external_id, 'project/external_id', 128);
  const found = rows(
    await db
      .from<ProjectRow>('cloud_project')
      .select('id,visibility,title')
      .eq('owner_id', principal.ownerId)
      .eq('external_id', externalId)
      .limit(1),
    BackendError,
  );

  const patch = {
    title: requiredText(batch.project.title, 'project/title', 300),
    question: text(batch.project.question, 'project/question', 2000),
    strategy: text(batch.project.strategy, 'project/strategy', 32),
    autonomy: text(batch.project.autonomy, 'project/autonomy', 32),
    source_host: text(batch.project.source_host, 'project/source_host', 200),
    schema_version: batch.local_schema_version,
    last_sync_at: new Date().toISOString(),
  };

  if (found[0]) {
    const updated = rows(
      await db.from<ProjectRow>('cloud_project').update(patch).eq('id', found[0].id).select('id,visibility,title'),
      BackendError,
    );
    if (!updated[0]) throw new BackendError('write_conflict', 409);
    return { row: updated[0], created: false };
  }

  const inserted = rows(
    await db
      .from<ProjectRow>('cloud_project')
      .insert({ owner_id: principal.ownerId, external_id: externalId, ...patch })
      .select('id,visibility,title'),
    BackendError,
  );
  if (!inserted[0]) throw new BackendError('write_failed', 500);
  return { row: inserted[0], created: true };
}

async function upsertRuns(
  db: Db,
  projectId: string,
  list: Record<string, unknown>[],
  BackendError: BackendErrorLike,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const run of list) {
    const externalRunId = requiredText(run.external_run_id, 'run/external_run_id', 128);
    const budget = (run.budget ?? {}) as { budget_usd_micro?: number; spent_usd_micro?: number };
    const patch = {
      status: requiredText(run.status, 'run/status', 32),
      phase_tag: requiredText(run.phase_tag, 'run/phase_tag', 64),
      question: text(run.question, 'run/question', 2000),
      block_reason: text(run.block_reason, 'run/block_reason', 500),
      error_class: text(run.error_class, 'run/error_class', 64),
      summary: text(run.summary, 'run/summary', 400),
      started_at: iso(run.started_at),
      finished_at: iso(run.finished_at),
      heartbeat_at: iso(run.heartbeat_at),
      config_hash: run.config_hash === null || run.config_hash === undefined ? null : String(run.config_hash),
      budget_usd_micro: Number.isInteger(budget.budget_usd_micro) ? budget.budget_usd_micro : 0,
      spent_usd_micro: Number.isInteger(budget.spent_usd_micro) ? budget.spent_usd_micro : 0,
      synced_at: new Date().toISOString(),
    };
    if (run.config_hash !== null && run.config_hash !== undefined && !isSha256(run.config_hash)) {
      throw new ContractError('/run/config_hash 不是 sha256:<64 hex>');
    }

    const existing = rows(
      await db
        .from<{ id: string }>('cloud_run')
        .select('id')
        .eq('project_id', projectId)
        .eq('external_run_id', externalRunId)
        .limit(1),
      BackendError,
    );
    let id = existing[0]?.id;
    if (id) {
      rows(await db.from('cloud_run').update(patch).eq('id', id).select('id'), BackendError);
    } else {
      const created = rows(
        await db
          .from<{ id: string }>('cloud_run')
          .insert({ project_id: projectId, external_run_id: externalRunId, ...patch })
          .select('id'),
        BackendError,
      );
      id = created[0]?.id;
    }
    if (!id) throw new BackendError('write_failed', 500);
    ids.set(externalRunId, id);
  }
  return ids;
}

async function writeStages(
  db: Db,
  runIds: Map<string, string>,
  list: Record<string, unknown>[],
  BackendError: BackendErrorLike,
): Promise<number> {
  let written = 0;
  for (const stage of list) {
    const runId = runIds.get(String(stage.run_external_id));
    if (!runId) throw new ContractError(`阶段引用了批内不存在的运行：${String(stage.run_external_id)}`);
    const patch = {
      state: requiredText(stage.state, 'stage/state', 16),
      stage_known: stage.stage_known !== false,
      gate_note: text(stage.gate_note, 'stage/gate_note', 400),
      blocker_code: text(stage.blocker_code, 'stage/blocker_code', 64),
      entered_at: iso(stage.entered_at),
      exited_at: iso(stage.exited_at),
    };
    const existing = rows(
      await db
        .from<{ id: string }>('cloud_stage_progress')
        .select('id')
        .eq('run_id', runId)
        .eq('stage', requiredText(stage.stage, 'stage/stage', 64))
        .limit(1),
      BackendError,
    );
    if (existing[0]) {
      rows(await db.from('cloud_stage_progress').update(patch).eq('id', existing[0].id).select('id'), BackendError);
    } else {
      rows(
        await db
          .from('cloud_stage_progress')
          .insert({ run_id: runId, stage: String(stage.stage), ...patch })
          .select('id'),
        BackendError,
      );
    }
    written += 1;
  }
  return written;
}

async function writeEvents(
  db: Db,
  runIds: Map<string, string>,
  list: Record<string, unknown>[],
  BackendError: BackendErrorLike,
): Promise<number> {
  let written = 0;
  for (const event of list) {
    const runId = runIds.get(String(event.run_external_id));
    if (!runId) throw new ContractError(`事件引用了批内不存在的运行：${String(event.run_external_id)}`);
    const seq = event.seq;
    if (!Number.isInteger(seq) || (seq as number) < 0) throw new ContractError('/event/seq 必须是非负整数');
    const ts = iso(event.ts);
    if (!ts) throw new ContractError('/event/ts 缺失：没有时间戳的事件无法排序');
    if (!isSafePathHint(event.object_id)) throw new ContractError('/event/object_id 形状不合法');

    const row = {
      run_id: runId,
      seq,
      ts,
      phase_tag: text(event.phase_tag, 'event/phase_tag', 64),
      object_type: text(event.object_type, 'event/object_type', 64),
      object_id: text(event.object_id, 'event/object_id', 128),
      actor_role: text(event.actor_role, 'event/actor_role', 64),
      type: requiredText(event.event_type, 'event/event_type', 96),
      summary: requiredText(event.summary, 'event/summary', 400),
      truncated: event.truncated === true,
      level: text(event.level, 'event/level', 16) ?? 'info',
      artifact_refs: Array.isArray(event.artifact_refs) ? event.artifact_refs : null,
    };
    // `(run_id, seq)` 唯一：同一批重放不产生重复行，缺口也因此能被算出来。
    const created = rows(
      await db
        .from<{ id: string }>('cloud_run_event')
        .insertIfAbsent(row, { onConflict: 'run_id,seq' })
        .select('id'),
      BackendError,
    );
    if (created.length > 0) written += 1;
  }
  return written;
}

/**
 * M6: 审批请求写入——幂等 upsert by (run_id, external_approval_id)。
 *
 * 注意：这里只写投影，不触发执行。审批请求是引擎向 Owner 发出的确认邀请，
 * Owner 在界面上提交意向后，意向由本地引擎 pull 并 adjudicate。
 */
async function writeApprovals(
  db: Db,
  runIds: Map<string, string>,
  list: Record<string, unknown>[],
  BackendError: BackendErrorLike,
): Promise<number> {
  let written = 0;
  for (const approval of list) {
    const runId = runIds.get(String(approval.run_external_id));
    if (!runId) throw new ContractError(`审批引用了批内不存在的运行：${String(approval.run_external_id)}`);
    const externalApprovalId = requiredText(approval.external_approval_id, 'approval/external_approval_id', 128);
    const kind = requiredText(approval.kind, 'approval/kind', 32);
    if (!['protocol', 'decision', 'repair'].includes(kind)) {
      throw new ContractError(`/approvals/kind 必须是 protocol|decision|repair，收到 ${kind}`);
    }
    const row = {
      run_id: runId,
      external_approval_id: externalApprovalId,
      kind,
      summary: requiredText(approval.summary, 'approval/summary', 800),
      options: Array.isArray(approval.options) ? approval.options : null,
      payload_hash: approval.payload_hash === null || approval.payload_hash === undefined ? null : String(approval.payload_hash),
      status: text(approval.status, 'approval/status', 32) ?? 'pending',
      created_at: iso(approval.created_at),
      resolved_at: iso(approval.resolved_at),
    };
    const existing = rows(
      await db
        .from<{ id: string }>('cloud_approval_request')
        .select('id')
        .eq('run_id', runId)
        .eq('external_approval_id', externalApprovalId)
        .limit(1),
      BackendError,
    );
    if (existing[0]) {
      rows(await db.from('cloud_approval_request').update(row).eq('id', existing[0].id).select('id'), BackendError);
    } else {
      rows(
        await db.from<{ id: string }>('cloud_approval_request').insert(row).select('id'),
        BackendError,
      );
    }
    written += 1;
  }
  return written;
}

/**
 * M6: 成本条目写入——幂等 upsert by (run_id, external_cost_id)。
 *
 * F12.1: 整数微美元，避免浮点累加误差。Function 必须解析并拒绝 NaN/Infinity。
 */
async function writeCosts(
  db: Db,
  runIds: Map<string, string>,
  list: Record<string, unknown>[],
  BackendError: BackendErrorLike,
): Promise<number> {
  let written = 0;
  for (const cost of list) {
    const runId = runIds.get(String(cost.run_external_id));
    if (!runId) throw new ContractError(`成本引用了批内不存在的运行：${String(cost.run_external_id)}`);
    const externalCostId = requiredText(cost.external_cost_id, 'cost/external_cost_id', 128);
    const kind = requiredText(cost.kind, 'cost/kind', 32);
    if (!['token', 'compute', 'storage', 'other'].includes(kind)) {
      throw new ContractError(`/costs/kind 必须是 token|compute|storage|other，收到 ${kind}`);
    }
    const usdMicro = cost.usd_micro;
    if (!Number.isInteger(usdMicro) || (usdMicro as number) < 0) {
      throw new ContractError('/costs/usd_micro 必须是非负整数（微美元）');
    }
    // F12.1: 拒绝 NaN/Infinity
    if (typeof usdMicro === 'number' && (!Number.isFinite(usdMicro) || Number.isNaN(usdMicro))) {
      throw new ContractError('/costs/usd_micro 不得为 NaN 或 Infinity');
    }
    const row = {
      run_id: runId,
      external_cost_id: externalCostId,
      kind,
      model_route: text(cost.model_route, 'cost/model_route', 128),
      agent_role: text(cost.agent_role, 'cost/agent_role', 64),
      usd_micro: usdMicro as number,
      tokens_in: Number.isInteger(cost.tokens_in) ? (cost.tokens_in as number) : null,
      tokens_out: Number.isInteger(cost.tokens_out) ? (cost.tokens_out as number) : null,
      ts: iso(cost.ts) ?? new Date().toISOString(),
    };
    const existing = rows(
      await db
        .from<{ id: string }>('cloud_cost_entry')
        .select('id')
        .eq('run_id', runId)
        .eq('external_cost_id', externalCostId)
        .limit(1),
      BackendError,
    );
    if (existing[0]) {
      rows(await db.from('cloud_cost_entry').update(row).eq('id', existing[0].id).select('id'), BackendError);
    } else {
      rows(
        await db.from<{ id: string }>('cloud_cost_entry').insert(row).select('id'),
        BackendError,
      );
    }
    written += 1;
  }
  return written;
}

/**
 * M6: 外发条目写入——幂等 upsert by (run_id, external_egress_id)。
 *
 * 缺口⑫：只有类别与计数，没有 prompt 字段，也不该将来加一个。
 */
async function writeEgress(
  db: Db,
  runIds: Map<string, string>,
  list: Record<string, unknown>[],
  BackendError: BackendErrorLike,
): Promise<number> {
  let written = 0;
  for (const egress of list) {
    const runId = runIds.get(String(egress.run_external_id));
    if (!runId) throw new ContractError(`外发引用了批内不存在的运行：${String(egress.run_external_id)}`);
    const externalEgressId = requiredText(egress.external_egress_id, 'egress/external_egress_id', 128);
    const destinationClass = requiredText(egress.destination_class, 'egress/destination_class', 64);
    const eventCount = egress.event_count;
    if (!Number.isInteger(eventCount) || (eventCount as number) < 0) {
      throw new ContractError('/egress/event_count 必须是非负整数');
    }
    const row = {
      run_id: runId,
      external_egress_id: externalEgressId,
      destination_class: destinationClass,
      data_class: text(egress.data_class, 'egress/data_class', 32),
      event_count: eventCount as number,
      bytes_approx: Number.isInteger(egress.bytes_approx) ? (egress.bytes_approx as number) : null,
      ts: iso(egress.ts) ?? new Date().toISOString(),
    };
    const existing = rows(
      await db
        .from<{ id: string }>('cloud_egress_entry')
        .select('id')
        .eq('run_id', runId)
        .eq('external_egress_id', externalEgressId)
        .limit(1),
      BackendError,
    );
    if (existing[0]) {
      rows(await db.from('cloud_egress_entry').update(row).eq('id', existing[0].id).select('id'), BackendError);
    } else {
      rows(
        await db.from<{ id: string }>('cloud_egress_entry').insert(row).select('id'),
        BackendError,
      );
    }
    written += 1;
  }
  return written;
}

/**
 * outbox 是投影表与 WS 之间唯一的耦合点（F17.3）：ingest 事务内写，广播侧消费。
 * seq 由这里赋值——受管 DDL 没有 serial/identity，顺序号只能是应用侧概念。
 * 读最大值再 +1 在并发下会给两个批同一个 seq；M1 接受这个已知弱点并在
 * 冲突时放弃广播（不影响落库），M-3 量完并发再决定改用本地事件序号。
 */
async function appendOutbox(
  db: Db,
  projectId: string,
  payload: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<void> {
  const latest = rows<{ seq: number }>(
    await db.from<{ seq: number }>('live_outbox').select('seq').eq('project_id', projectId).order('seq', { ascending: false }).limit(1),
    BackendError,
  );
  const seq = (latest[0]?.seq ?? 0) + 1;
  try {
    rows(
      await db
        .from('live_outbox')
        .insert({ project_id: projectId, frame_type: 'state', payload, seq })
        .select('id'),
      BackendError,
    );
  } catch {
    // 广播缺口由 WS 侧的 seq 跳号暴露，不能因为它把整批写成失败。
  }
}

export async function ingestBatch(
  db: Db,
  principal: SyncPrincipal,
  batch: BatchEnvelope,
  assertProjectAllowed: (principal: SyncPrincipal, externalId: string, BackendError: BackendErrorLike) => void,
  BackendError: BackendErrorLike,
): Promise<Response> {
  assertProjectAllowed(principal, String(batch.project.external_id), BackendError);

  const skipped = present(batch).filter((name) => !(IMPLEMENTED as readonly string[]).includes(name));
  if (skipped.length > 0) {
    throw new BackendError(`projection_collections_not_implemented:${skipped.join(',')}`, 501);
  }

  const { row: project } = await resolveProject(db, principal, batch, BackendError);

  const batchRow = rows<{ id: string }>(
    await db
      .from<{ id: string }>('cloud_sync_batch')
      .insertIfAbsent(
        {
          project_id: project.id,
          token_id: principal.tokenId,
          external_batch_id: batch.external_batch_id,
          schema_version: batch.local_schema_version,
          entity_counts: batch.entities,
          status: 'accepted',
        },
        { onConflict: 'external_batch_id' },
      )
      .select('id'),
    BackendError,
  );
  if (batchRow.length === 0) {
    return Response.json({ ok: true, status: 'replay', external_batch_id: batch.external_batch_id });
  }

  const runIds = await upsertRuns(db, project.id, (batch.entities.runs ?? []) as Record<string, unknown>[], BackendError);
  const stages = await writeStages(db, runIds, (batch.entities.stages ?? []) as Record<string, unknown>[], BackendError);
  const events = await writeEvents(db, runIds, (batch.entities.events ?? []) as Record<string, unknown>[], BackendError);
  // M6: 新增集合写入
  const approvals = await writeApprovals(db, runIds, (batch.entities.approvals ?? []) as Record<string, unknown>[], BackendError);
  const costs = await writeCosts(db, runIds, (batch.entities.costs ?? []) as Record<string, unknown>[], BackendError);
  const egress = await writeEgress(db, runIds, (batch.entities.egress ?? []) as Record<string, unknown>[], BackendError);

  await appendOutbox(
    db,
    project.id,
    { external_id: batch.project.external_id, runs: runIds.size, stages, events, approvals, costs, egress, at: new Date().toISOString() },
    BackendError,
  );

  return Response.json({
    ok: true,
    status: 'accepted',
    external_batch_id: batch.external_batch_id,
    counts: { runs: runIds.size, stages, events, approvals, costs, egress },
  });
}
