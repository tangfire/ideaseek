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
  /** 写权限只属于 Owner：前端据此隐藏排队按钮，不自己从可见性推断。 */
  writable?: boolean;
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

// ---------------------------------------------------------------------------
// M6: 审批信箱 / 成本 / 外发 / Token 管理
// ---------------------------------------------------------------------------

/**
 * F11: 审批请求——云端只存意向，生效需本地 pull + Owner 二次确认（REQUIREMENTS.md §3.3）。
 * kind 三值：protocol（协议审批）、decision（决策审批）、repair（修复审批）。
 */
export interface ApprovalRequest {
  id: string;
  run_external_id: string;
  external_approval_id: string;
  kind: 'protocol' | 'decision' | 'repair';
  summary: string;
  options: string[] | null;
  payload_hash: string | null;
  status: 'pending' | 'resolved' | 'expired';
  created_at: string;
  resolved_at: string | null;
  /** F11.4: 已提交的意向列表——多个审批人可能选不同选项，并列展示不自动合并。 */
  intents?: ApprovalIntent[];
}

/**
 * F11.3-F11.5: 审批意向——Owner 在界面上提交的选择，待本地引擎拉取后生效。
 * 生命周期：submitted → delivered → consumed。
 */
export interface ApprovalIntent {
  id: string;
  choice: string;
  note: string | null;
  submitted_at: string;
  delivered_at: string | null;
  consumed_at: string | null;
}

/** F12: 成本条目——整数微美元，避免浮点累加误差。 */
export interface CostEntry {
  id: string;
  run_external_id: string;
  external_cost_id: string;
  kind: 'token' | 'compute' | 'storage' | 'other';
  model_route: string | null;
  agent_role: string | null;
  usd_micro: number;
  tokens_in: number | null;
  tokens_out: number | null;
  ts: string;
}

/** F12: 成本汇总——按 run 聚合。 */
export interface CostSummary {
  run_external_id: string;
  total_usd_micro: number;
  total_tokens_in: number;
  total_tokens_out: number;
  budget_usd_micro: number;
  spent_usd_micro: number;
  /** F12.3: 重复成本标记——同一 run 内相同 model_route + kind 出现多次。 */
  duplicate_candidates: number;
  by_route: Record<string, number>;
}

/** F13: 外发条目——只有类别与计数，没有 prompt 字段（缺口⑫）。 */
export interface EgressEntry {
  id: string;
  run_external_id: string;
  external_egress_id: string;
  destination_class: string;
  data_class: string | null;
  event_count: number;
  bytes_approx: number | null;
  ts: string;
}

/** F16: 同步 Token——只存哈希，明文永不入库（NFR-02）。 */
export interface SyncToken {
  id: string;
  label: string | null;
  scopes: string[];
  project_scope: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** F16.2: 同步健康自检——最近批次状态与拒绝原因分布。 */
export interface SyncHealth {
  latest_batch: {
    external_batch_id: string;
    status: string;
    requested_at: string;
    rejected_reasons: string[] | null;
  } | null;
  pending_batches: number;
  rejected_reason_distribution: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Web-First 反向通道：命令队列 / 本地 Agent 在线 / 仓库与文件上报
// 对应 `web/functions/commands.ts`，字段名沿用 cloud_command 列名（NFR-12）。
// ---------------------------------------------------------------------------

/** 命令状态机：queued→claimed→running→终态；expired 不会自动重排。 */
export type CommandStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'expired' | 'canceled';

export interface CommandCard {
  command_id: string;
  type: string;
  status: CommandStatus;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
  projection_level: 'full' | 'l2';
  /** full 级才有这三个：载荷含研究问题，错误首行含本地路径线索。 */
  payload?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/** 排了队但还没落到投影的创建请求：project_create 成功后项目行才由本地引擎写回来。 */
export interface ProvisioningEntry {
  command_id: string;
  status: CommandStatus;
  created_at: string;
  name: string | null;
}

export interface CommandsView {
  ok: true;
  generated_at: string;
  projection_level: 'full' | 'l2';
  writable: boolean;
  commands: CommandCard[];
  provisioning: ProvisioningEntry[];
}

export interface LocalProjectEntry {
  path: string | null;
  name: string | null;
  external_id: string | null;
}

export interface AgentPresenceView {
  ok: true;
  generated_at: string;
  writable: boolean;
  online: boolean;
  last_seen_at: string | null;
  agent_version: string | null;
  active_commands: number;
  local_projects: LocalProjectEntry[];
  reported_for_project: boolean;
}

export interface GitState {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number | null;
  unstaged: number | null;
  untracked: number | null;
  last_commit_hash: string | null;
  last_commit_at: string | null;
  last_commit_text: string | null;
  dirty: boolean | null;
  reported_at: string;
}

export interface FileNode {
  path: string;
  kind: string;
  size: number | null;
  mime_type: string | null;
  updated_at: string | null;
  reported_at: string;
}

export interface RepoView {
  ok: true;
  generated_at: string;
  projection_level: 'full';
  writable: boolean;
  git: GitState | null;
  files: FileNode[];
  file_count: number;
}
