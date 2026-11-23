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
  /** F2.5: 阻塞原因的详细说明——卡在哪、等什么、下一步建议。L1 字段。 */
  block_detail?: {
    kind: string;
    message: string;
    next?: string;
  } | null;
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
  /** F8: Idea 看板数据——L1 字段，L2 降级时不返回。 */
  ideas?: IdeaSummary[];
  /** F9: 论文卡片——L1 字段，L2 降级时不返回。 */
  papers?: PaperCard[];
  /** F9: 结论陈述——L1 字段，L2 降级时不返回。 */
  claims?: ClaimRow[];
  /** F10: 实验结果——L1 字段，L2 降级时不返回。 */
  experiments?: ExperimentResult[];
  /** F10: 实验协议——L1 字段，L2 降级时不返回。 */
  protocols?: ProtocolSummary[];
  /** 本地还有多少批没同步上来——投影缺口的可见化，不是装饰。 */
  unsynced: { pending_batches: number; dropped_events: number } | null;
}

export type LiveFrame =
  | { type: 'state'; project_id: string; seq: number; run: RunSummary; stages: StageProgress[] }
  | { type: 'events'; project_id: string; seq: number; events: EventRow[] }
  | { type: 'revoked'; project_id: string; seq: number; reason: string };

/**
 * F8: Idea 看板与版本树相关类型。
 *
 * Idea 是研究假设的载体，每个 idea 有标题、机制摘要、状态、结论。
 * 版本树通过 parent_idea_id 链接，假设变更产生新 idea。
 */
export interface IdeaSummary {
  external_idea_id: string;
  title: string;
  /** L1: hypothesis 默认 withheld，只有 Owner 显式放开才可见。 */
  hypothesis?: string | null;
  hypothesis_disclosure: 'withheld' | 'structure' | 'full';
  mechanism_summary?: string | null;
  status: string;
  verdict?: string | null;
  version: number;
  parent_idea_id?: string | null;
  ideation_round_id?: string | null;
}

export interface IdeationRound {
  external_round_id: string;
  round_index: number;
  note?: string | null;
  created_at?: string | null;
}

/**
 * F9: 证据链追溯相关类型。
 *
 * Claim 是论文中的结论陈述，通过 evidence_ref 链接到具体页码。
 */
export interface ClaimRow {
  external_claim_id: string;
  idea_id: string;
  text: string;
  support_level: string;
  evidence_ref?: {
    paper_external_id?: string;
    page?: number;
    section?: string;
  } | null;
}

export interface PaperCard {
  external_paper_id: string;
  title: string;
  question?: string | null;
  method_summary?: string | null;
  parse_status: string;
}

/**
 * F10: 实验结果与协议对比相关类型。
 */
export interface ExperimentResult {
  external_spec_id: string;
  idea_id: string;
  scale: 'smoke' | 'quick' | 'standard' | 'handoff_manifest';
  status: string;
  metrics?: Record<string, number> | null;
  verdict?: string | null;
}

export interface ProtocolSummary {
  external_protocol_id: string;
  idea_id?: string | null;
  locked_at?: string | null;
  provenance?: string | null;
}
