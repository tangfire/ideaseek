/**
 * 视图读接线的返回形状。与 `web/functions/views.ts` 一一对应；
 * 字段名沿用 cloud_* 列名，避免在中间再翻译一套词汇（NFR-12）。
 */
export interface RunSummary {
  external_run_id: string;
  phase_tag: string;
  stage_known: boolean;
  started_at: string | null;
  finished_at: string | null;
  /**
   * 以下都是 L1（REQUIREMENTS.md:109）：`projection_level='l2'` 的响应里
   * **根本没有这些键**，所以它们必须是可选的——把缺失渲染成 `undefined`
   * 就是公开页面上的一处破版。
   */
  status?: string;
  question?: string | null;
  block_reason?: string | null;
  heartbeat_at?: string | null;
  budget_usd_micro?: number;
  spent_usd_micro?: number;
  summary?: string | null;
}

export interface StageProgress {
  stage: string;
  state: string;
  stage_known: boolean;
  gate_note: string | null;
  blocker_code: string | null;
}

export interface EventRow {
  seq: number;
  ts: string;
  phase_tag: string | null;
  type: string;
  summary: string;
  truncated: boolean;
  level: string;
  gap_before: number;
}

export interface ProjectIndexEntry {
  external_id: string;
  title: string;
  visibility: 'private' | 'link' | 'listed';
  last_sync_at: string | null;
  latest_run: RunSummary | null;
}

export interface IndexView {
  ok: true;
  generated_at: string;
  projects: ProjectIndexEntry[];
}

export interface ProjectView {
  ok: true;
  generated_at: string;
  visibility: 'private' | 'link' | 'listed';
  /** Function 侧的列级降级判定（F5.2）：`l2` 时下面这些 L1 字段不会出现在响应里。 */
  projection_level: 'full' | 'l2';
  redacted_fields?: string[];
  project: {
    external_id: string;
    title: string;
    question: string | null;
    strategy?: string | null;
    autonomy?: string | null;
    last_sync_at: string | null;
  };
  runs: RunSummary[];
  stages: StageProgress[];
  events: EventRow[];
  /** 本地还有多少批没同步上来——投影缺口的可见化，不是装饰。 */
  unsynced: { pending_batches: number; dropped_events: number } | null;
}

export type LiveFrame =
  | { type: 'state'; project_id: string; seq: number; run: RunSummary; stages: StageProgress[] }
  | { type: 'events'; project_id: string; seq: number; events: EventRow[] }
  | { type: 'revoked'; project_id: string; seq: number; reason: string };
