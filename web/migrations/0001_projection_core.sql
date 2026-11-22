-- IdeaSeek Web 控制台 — cloud_* 投影表（M1 交付物：建表）
--
-- 目标引擎：Qoder Sites 托管库（Supabase Postgres），经 create_database_migration
-- 的受管子集提交。本文件按该子集写（spike 报告 S2 有出处）：
--   * 只接受 CREATE TABLE app.<t> / ALTER TABLE ADD COLUMN / 普通 CREATE INDEX；
--     没有 BEGIN/COMMIT、没有 IF NOT EXISTS、没有 DML。
--   * 类型限 boolean / integer / bigint / text / uuid / timestamptz / jsonb；
--     数组、numeric、double precision、varchar(n) 都不在列。
--   * 建表约束限 NULL / NOT NULL / PRIMARY KEY / UNIQUE / app 内 REFERENCES；
--     **CHECK 不支持**，identity/serial/generated 也不支持。
--   * 索引只允许普通列名：没有 DESC、没有 WHERE（部分索引）、没有表达式。
--   * **单个 plan 的语句数有上限**（实测 20 条通过、38 条整份拒绝且无逐条原因），
--     所以本文件只到 cloud_comparison，其余表在 0002_projection_deep.sql。
--   * 提交时去掉注释：子集文档没写是否支持注释，不赌解析器；本文件的注释是给人读的。
--
-- CHECK 不支持带来一个真实的降级，必须说清楚：长度上限、sha256 形状、路径不含
-- `..`、withheld 假设不得带全文这些不变量，原本打算在列上钉死，现在只能由两处
-- 承担——(1) cloud-projection-v1 契约，投影器在**出境前**用 ajv 校验、Function
-- 在落库前再校验一次；(2) Function 的写路径本身。因此本库的**唯一写入者必须是
-- ingest 路由**：绕过它直接写库的连接不受任何列级约束保护。这一条不是理论风险，
-- function_backend 生成的固定私有策略正好保证了浏览器拿不到库（见 S5）。
--
-- 三条贯穿全部表的不变量，改任何一条都要回到 REQUIREMENTS.md §3.2/§3.3 重新评审：
--   1. 只读投影：这些表不是权威，可整体删除后从本地 workflow.sqlite 重建。
--   2. 幂等：每个实体带 (project_id, external_*_id) 唯一键，重放同一批不产生重复行。
--   3. 无正文：artifact / 论文 / 数据集内容不落库，只有引用、哈希与定位。
--
-- REFERENCES 一律不带 ON DELETE 子句：受管子集没有列出 referential action，
-- 与其让整份 plan 因为一个未文档化的语法被拒，不如把级联交给显式删除路径
-- （UC-22 删除云端投影）在 Function 里做，语义反而更明确。

-- ---------------------------------------------------------------- 所有者与凭据

CREATE TABLE app.cloud_owner (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text,
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- sync_token 只存哈希（NFR-02）：明文 token 入库等于把吊销能力变成摆设。
-- 它是**本地引擎的机器凭据**，与浏览者的 Qoder 身份是两套主体（见 spike 报告 S5）。
CREATE TABLE app.cloud_sync_token (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES app.cloud_owner(id),
  token_hash     text NOT NULL UNIQUE,
  label          text,
  scopes         jsonb NOT NULL,          -- 数组，Function 侧校验形状
  project_scope  jsonb NOT NULL,          -- 空数组 = 全部项目
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);

CREATE INDEX idx_sync_token_owner ON app.cloud_sync_token (owner_id);

-- ------------------------------------------------------------------ 项目与批次

CREATE TABLE app.cloud_project (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES app.cloud_owner(id),
  external_id     text NOT NULL,
  title           text NOT NULL,
  question        text,
  strategy        text,                   -- starter|standard|research，契约层校验
  autonomy        text,                   -- guided|autonomous|review-only
  -- Q1：三级，public 更名为 listed。语义是递进的两个动作，不是一个开关的两档。
  visibility      text NOT NULL DEFAULT 'private',
  source_host     text,
  schema_version  integer NOT NULL DEFAULT 1,
  last_sync_at    timestamptz,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, external_id)
);

-- 列表查询的热路径。没有部分索引，所以"只取 listed"由 Function 的 WHERE 承担。
CREATE INDEX idx_project_listed ON app.cloud_project (visibility, last_sync_at);

CREATE TABLE app.cloud_sync_batch (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES app.cloud_project(id),
  token_id           uuid REFERENCES app.cloud_sync_token(id),
  external_batch_id  text NOT NULL,
  schema_version     integer NOT NULL,
  entity_counts      jsonb,
  rejected_reasons   jsonb,
  status             text NOT NULL,        -- accepted|partial|rejected
  requested_at       timestamptz NOT NULL DEFAULT now(),
  -- 幂等键（NFR-06）。全局唯一而非 (project, batch)：本地 newId 已是随机 16 hex，
  -- 跨项目撞号概率可忽略，而全局唯一能挡住"同一批被投递到两个项目"。
  UNIQUE (external_batch_id)
);

CREATE INDEX idx_sync_batch_project ON app.cloud_sync_batch (project_id, requested_at);

-- -------------------------------------------------------------------- 运行观测

CREATE TABLE app.cloud_run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES app.cloud_project(id),
  external_run_id  text NOT NULL,
  -- 引擎 RunStatus 原文九值，不翻译也不合并（NFR-12）；枚举在契约层。
  status           text NOT NULL,
  -- 开放文本而非 14 阶段枚举：types.ts 的 RunPhase 只有 INIT|DEMO|COMPLETED，
  -- 写死 14 值会造出一份引擎满足不了的契约。未知阶段由 stage_known 显式暴露。
  phase_tag        text NOT NULL,
  question         text,
  block_reason     text,
  error_class      text,
  summary          text,                   -- <=400，由契约强制
  started_at       timestamptz,
  finished_at      timestamptz,
  heartbeat_at     timestamptz,
  -- 配置只留哈希：完整 config 快照可能含本地路径与凭据引用。
  config_hash      text,
  budget_usd_micro bigint NOT NULL DEFAULT 0,
  spent_usd_micro  bigint NOT NULL DEFAULT 0,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_run_id)
);

CREATE INDEX idx_run_project_started ON app.cloud_run (project_id, started_at);

-- 阶段视图。stage_known=false 让"规范 14 阶段 / 实现只有 3 个 RunPhase"这道真实
-- 差距在界面上可见，而不是被投影层悄悄抹平（DIAGRAMS.md §4 第 2 条）。
CREATE TABLE app.cloud_stage_progress (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES app.cloud_run(id),
  stage            text NOT NULL,
  state            text NOT NULL,          -- pending|active|blocked|passed|failed
  stage_known      boolean NOT NULL DEFAULT true,
  gate_note        text,
  blocker_code     text,
  entered_at       timestamptz,
  exited_at        timestamptz,
  UNIQUE (run_id, stage)
);

CREATE TABLE app.cloud_task (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES app.cloud_run(id),
  external_task_id    text NOT NULL,
  kind                text NOT NULL,
  agent_role          text,
  status              text NOT NULL,       -- 引擎 TaskStatus 原文七值
  phase_tag           text,
  attempt             integer NOT NULL DEFAULT 0,
  max_attempts        integer,
  started_at          timestamptz,
  ended_at            timestamptz,
  artifact_count      integer NOT NULL DEFAULT 0,
  -- 失败必须带原因：failed 而无 error_class 正是本仓库一直在收口的静默降级。
  -- 这条"if failed then error_class"是有条件的，列约束本来也表达不了，落在契约。
  error_class         text,
  error_summary       text,
  UNIQUE (run_id, external_task_id)
);

CREATE INDEX idx_task_run_status ON app.cloud_task (run_id, status);

-- 事件流。seq 直接沿用本地 per-run 序号，缺口才能被检测出来：页面可以显示
-- "N 条事件未同步"，而不是安静地展示一条更短的时间线。
CREATE TABLE app.cloud_run_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES app.cloud_run(id),
  seq              bigint NOT NULL,
  ts               timestamptz NOT NULL,
  phase_tag        text,
  object_type      text,
  object_id        text,
  actor_role       text,
  type             text NOT NULL,
  -- 已脱敏、限长（NFR-03）。截断显式标记，避免半句话读起来像完整结论。
  summary          text NOT NULL,
  truncated        boolean NOT NULL DEFAULT false,
  level            text NOT NULL DEFAULT 'info',
  artifact_refs    jsonb,
  UNIQUE (run_id, seq)
);

CREATE INDEX idx_run_event_run_ts ON app.cloud_run_event (run_id, ts);

-- 引用与哈希，没有正文列，也没有 inline/encoding 之类的口子。
CREATE TABLE app.cloud_artifact_ref (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES app.cloud_run(id),
  external_artifact_id  text NOT NULL,
  external_task_id      text,
  kind                  text NOT NULL,
  content_hash          text NOT NULL,     -- sha256:…，形状由契约把关
  size_bytes            bigint NOT NULL DEFAULT 0,
  -- 相对路径，禁止绝对路径与 `..`：本地路径本身就是泄露（用户名、挂载布局）。
  path_hint             text,
  status                text NOT NULL,     -- staged|committed|aborted
  committed_at          timestamptz,
  UNIQUE (run_id, external_artifact_id)
);

-- ------------------------------------------------------------------ 知识与协议

CREATE TABLE app.cloud_paper_card (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES app.cloud_project(id),
  external_paper_id    text NOT NULL,
  document_hash        text,
  -- 标题是书目元数据；摘要与正文属于用户语料，不落这张表。
  title                text NOT NULL,
  problem              text,
  method_summary       text,
  status               text NOT NULL,      -- ok|failed|partial
  parser_version       text,
  claim_count          integer NOT NULL DEFAULT 0,
  unknown_count        integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, external_paper_id)
);

-- disclosure 三态把"是否上线"与"谁可读"分开：claim 文本是未发表成果，默认
-- withheld；升档必须是 Owner 动作并留审计行。列名用 claim_text——`text` 是类型名，
-- 受管解析器不是 Postgres 本体，能不赌就不赌。
CREATE TABLE app.cloud_claim (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_card_id        uuid NOT NULL REFERENCES app.cloud_paper_card(id),
  external_claim_id    text NOT NULL,
  claim_text           text,
  stance               text,
  confidence           text,               -- high|medium|low
  ordinal              integer,
  disclosure           text NOT NULL DEFAULT 'withheld',
  UNIQUE (paper_card_id, external_claim_id)
);

-- 定位而非引文：页码/章节可追溯，摘录出来的句子就是语料内容。
CREATE TABLE app.cloud_evidence_ref (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id             uuid NOT NULL REFERENCES app.cloud_claim(id),
  external_evidence_id text NOT NULL,
  page                 integer,
  section              text,
  kind                 text NOT NULL,
  UNIQUE (claim_id, external_evidence_id)
);

CREATE TABLE app.cloud_protocol (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES app.cloud_project(id),
  external_protocol_id text NOT NULL,
  protocol_hash        text,
  status               text NOT NULL,      -- draft|proposed|locked|superseded
  task_definition      text,
  sample_unit          text,
  split_rule           text,
  primary_metrics      jsonb,
  confirmed_by         text,
  locked_at            timestamptz,
  UNIQUE (project_id, external_protocol_id)
);

-- ------------------------------------------------------- 对比方法 / idea / 实验

CREATE TABLE app.cloud_comparison (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES app.cloud_project(id),
  external_method_id     text NOT NULL,
  name                   text NOT NULL,
  -- 复现与官方代码必须分标（RESEARCH_INTEGRITY 红线）。
  code_source            text NOT NULL,    -- user|official-code|paper-reimplementation
  required               boolean NOT NULL DEFAULT true,
  status                 text NOT NULL,
  repro_confidence       text,
  -- 无凭据的来源标识。带 token 的 URL 由投影器在本地剥掉，并且 cloud-projection-v1
  -- 的 source_hint pattern 在出境前再挡一次——库里没有 CHECK 之后，这两道就是全部。
  source_hint            text,
  UNIQUE (project_id, external_method_id)
);
