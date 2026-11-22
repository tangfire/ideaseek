-- IdeaSeek Web 控制台 — cloud_* 深视图表（0001 的续片）
--
-- 拆片原因不是风格问题：受管迁移对**单个 plan 的语句数**有上限，实测 20 条通过、
-- 38 条整份 `sites_migration_rejected` 且没有逐条原因（见 SPIKE_SITES_RUNTIME.md §2）。
-- 所以按依赖顺序切成 0001（20 条：owner→comparison）与 0002（18 条：ideation_round→
-- live_outbox），两片各自都在已验证的规模内，且 0002 的外键目标全部由 0001 建好。
-- 提交前去掉注释：受管子集文档没有声明对注释的支持，不去赌解析器。

CREATE TABLE app.cloud_ideation_round (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES app.cloud_project(id),
  external_round_id  text NOT NULL,
  round_index        integer NOT NULL,     -- 投影字段名 index，列名避开关键字
  note               text,
  created_at         timestamptz,
  UNIQUE (project_id, external_round_id)
);

CREATE TABLE app.cloud_idea (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES app.cloud_project(id),
  ideation_round_id      uuid REFERENCES app.cloud_ideation_round(id),
  external_idea_id       text NOT NULL,
  parent_idea_id         uuid REFERENCES app.cloud_idea(id),
  title                  text NOT NULL,
  -- 假设全文默认不进入投影。withheld/structure 却带全文 = 投影器越界，
  -- 这道一致性检查原本钉在列上，现在由 cloud-projection-v1 的 allOf/if/then
  -- 在**出境前**拒绝（比列约束更早：列约束只在入库时才挡，字已经传过来了）。
  hypothesis             text,
  hypothesis_disclosure  text NOT NULL DEFAULT 'withheld',
  mechanism_summary      text,
  status                 text NOT NULL,
  verdict                text,
  version                integer,
  UNIQUE (project_id, external_idea_id)
);

CREATE INDEX idx_idea_parent ON app.cloud_idea (parent_idea_id);
CREATE INDEX idx_idea_project ON app.cloud_idea (project_id, status);

CREATE TABLE app.cloud_experiment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id              uuid REFERENCES app.cloud_idea(id),
  run_id               uuid NOT NULL REFERENCES app.cloud_run(id),
  protocol_id          uuid REFERENCES app.cloud_protocol(id),
  external_spec_id     text NOT NULL,
  spec_hash            text,
  -- scale 随行携带：NFR-13 禁止把 smoke/quick 切片渲染成已验证结论。
  scale                text NOT NULL,      -- smoke|quick|standard|handoff_manifest
  status               text NOT NULL,
  seed                 integer,
  failure_class        text,
  started_at           timestamptz,
  ended_at             timestamptz,
  UNIQUE (run_id, external_spec_id)
);

-- 指标值用 text：numeric / double precision 不在受管类型里。这不是将就——所有读路径
-- 都在 Function 里，聚合与比较本来就在 JS 侧做；换来的是 0.12 不会因为库内浮点
-- 往返而在页面上变成 0.12000000000000001。Function 必须解析并拒绝 NaN/Infinity。
CREATE TABLE app.cloud_metric_result (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id             uuid NOT NULL REFERENCES app.cloud_experiment(id),
  external_metric_id        text NOT NULL,
  name                      text NOT NULL,
  value_text                text,
  direction                 text,          -- higher_better|lower_better|unknown
  variance_text             text,
  n_runs                    integer,
  -- 合成/占位数值不得作为结果展示（NFR-13）。标记与数值同表同行，
  -- 任何视图都无法靠"忘记 join 侧表"来绕过它。
  is_synthetic              boolean NOT NULL DEFAULT false,
  baseline_comparison_id    uuid,
  delta_text                text,
  UNIQUE (experiment_id, external_metric_id)
);

-- ------------------------------------------------------------------ 审批信箱

CREATE TABLE app.cloud_approval_request (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES app.cloud_run(id),
  external_approval_id  text NOT NULL,
  kind                  text NOT NULL,     -- protocol|decision|repair
  summary               text NOT NULL,
  options               jsonb,
  -- 绑定本地载荷：对着过期投影做出的决定可被检出，而不是静默生效。
  payload_hash          text,
  status                text NOT NULL DEFAULT 'pending',
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  UNIQUE (run_id, external_approval_id)
);

CREATE INDEX idx_approval_pending ON app.cloud_approval_request (status, created_at);

-- 云端唯一的"写入面"，且只写意向。生效仍需本地 pull + Owner 二次确认
-- （REQUIREMENTS.md §3.3）。三级 delivered/consumed 让"点了"与"真生效"可区分。
CREATE TABLE app.cloud_approval_intent (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id   uuid NOT NULL REFERENCES app.cloud_approval_request(id),
  owner_id              uuid NOT NULL REFERENCES app.cloud_owner(id),
  choice                text NOT NULL,
  note                  text,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  consumed_at           timestamptz
);

CREATE INDEX idx_intent_request ON app.cloud_approval_intent (approval_request_id, consumed_at);

-- ---------------------------------------------------------------- 成本与外发

CREATE TABLE app.cloud_cost_entry (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               uuid NOT NULL REFERENCES app.cloud_run(id),
  external_cost_id     text NOT NULL,
  kind                 text NOT NULL,      -- token|compute|storage|other
  model_route          text,
  agent_role           text,
  -- 整数微美元：上千次调用累加浮点会得出一个对不上账单的总额。
  usd_micro            bigint NOT NULL DEFAULT 0,
  tokens_in            bigint,
  tokens_out           bigint,
  ts                   timestamptz NOT NULL,
  UNIQUE (run_id, external_cost_id)
);

-- 缺口⑫：只有类别与计数，没有 prompt 字段，也不该将来加一个。
CREATE TABLE app.cloud_egress_entry (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES app.cloud_run(id),
  external_egress_id    text NOT NULL,
  destination_class     text NOT NULL,
  data_class            text,              -- paper_text|dataset_feature|code|metadata|unknown
  event_count           integer NOT NULL DEFAULT 0,
  bytes_approx          bigint,
  ts                    timestamptz NOT NULL,
  UNIQUE (run_id, external_egress_id)
);

-- ------------------------------------------------------------------ 发布与分享

-- L2 再降级投影的 allowlist 落点：逐字段显式行，而不是"整项目公开"一个布尔。
CREATE TABLE app.cloud_publication (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL UNIQUE REFERENCES app.cloud_project(id),
  -- 谁在什么时候把哪些字段放到哪一级，可追溯（F5.7）。
  published_by      uuid NOT NULL REFERENCES app.cloud_owner(id),
  level             text NOT NULL,          -- link|listed
  fields_profile    jsonb,
  -- F5.9：进公开列表必须是第二次独立确认，不能由一次发布顺带完成。
  confirmed_listing boolean NOT NULL DEFAULT false,
  published_at      timestamptz NOT NULL DEFAULT now()
);

-- 分享 token：撤销即失效，且撤销后已建立的 WS 连接也要断（WS-06）。
CREATE TABLE app.cloud_share_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES app.cloud_project(id),
  token_hash    text NOT NULL UNIQUE,
  scope         text NOT NULL DEFAULT 'project',   -- project|run|idea
  object_id     text,
  created_by    uuid REFERENCES app.cloud_owner(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE INDEX idx_share_project ON app.cloud_share_token (project_id, revoked_at);

-- 受邀读者（Q8：邮箱邀请 + 不记名链接并存）。owner_id 存的是浏览者的 Qoder
-- user_id 映射，来自网关注入的 x-qoder-user-context，不是浏览器自报的。
CREATE TABLE app.cloud_grant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES app.cloud_project(id),
  email       text,
  owner_id    uuid REFERENCES app.cloud_owner(id),
  role        text NOT NULL DEFAULT 'reviewer',
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (project_id, email)
);

-- ------------------------------------------------------------------ 实时推送

-- 投影表与 WS 之间唯一的耦合点。ingest 事务内写，广播侧消费后即删；
-- WS 层不直读 cloud_*（F17.3）——否则每批 push 的读次数会随连接数增长，
-- 且两条读路径会长出两套视图。
--
-- seq 由 Function 在写入时赋值：受管子集不支持 serial/identity 列，所以顺序号
-- 是应用侧概念。同一项目内的并发赋值留到 S4 一起量——若两个并发批导致唯一键
-- 冲突，退路是改按 (project_id, run_external_id, seq) 用本地事件序号排序，
-- 那正好也是 WS-04 断点续传需要的游标语义。
CREATE TABLE app.live_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES app.cloud_project(id),
  batch_id      uuid REFERENCES app.cloud_sync_batch(id),
  frame_type    text NOT NULL,     -- state|events|revoked
  payload       jsonb NOT NULL,    -- <=8 KB，只放脱敏摘要
  seq           bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, seq)
);

CREATE INDEX idx_outbox_pending ON app.live_outbox (project_id, seq);

-- ================================================================== 策略与未落实的事
--
-- 本文件没有 `CREATE POLICY` / `GRANT`，而且**将来也不该加**：这不是待办，是 S5
-- 的结论。`ensure_backend(databaseAccessModel: function_backend)` 由 AppHub 生成
-- 固定私有策略，prepare_site 的 accessPolicies 必须留空；托管迁移子集本身也明确
-- 拒绝任意 SQL/policies。逐浏览者的可见性判定因此只能落在 Function 的 SQL 谓词里
-- （读路径唯一入口），而"库只能被 Function 访问"正是 function_backend 给的默认。
--
-- 仍然没有落实、需要后续里程碑处理的：
--   1. 列级 L1 屏蔽：契约用 disclosure 三态表达，Function 按级别决定 SELECT 哪些列。
--      若实测发现某些页面查询难以在谓词里表达，PLAN.md §5.3 的物理分表演法仍然可用，
--      但那是实现细节，不改变这里的数据形状。
--   2. 删除/吊销（UC-22）走 Function 显式删除，没有 ON DELETE CASCADE 兜底。
--   3. 全文检索、时间范围聚合等读优化，等真实投影数据规模出来后再加索引。
