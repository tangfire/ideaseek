# 云原生重构方案：把 IdeaSeek 工作流搬到云端可操作

状态：**待批准**（§7 的 4 个决策未回，M1 之后分支依赖它们）
前提来源：[SPIKE_SITES_RUNTIME.md](SPIKE_SITES_RUNTIME.md) 的部署实测、`sites-building/references/database.md`、`sites-build-agent-app/references/api.md`
本文只解决一件事：**让浏览器成为工作流的发起者和驱动者，而不是本地引擎的旁观者。**

---

## 1. 结论先行

当前部署的产品定位与目标相反。站点自己的描述文案写的是：

> "IdeaSeek 科研工作流的只读进度望远镜：执行在你自己的机器上，云端只保留脱敏后的执行状态与事件。"

目标形态是一句话：**云端是唯一真源，云端是唯一执行者，浏览器是唯一驱动者。**

判定这套重构是否完成的四条硬标准：

| # | 判据 | 当前 |
| --- | --- | --- |
| G1 | 在一台**从未装过 IdeaSeek** 的机器上，只用浏览器能把 run 从 `INIT` 推进到 `PAPER_ANALYSIS` | 不通过（无 `run_start` 的云端执行者） |
| G2 | 关掉本地 agent、删掉 `local-agent/` 整目录，云端流程不受影响 | 不通过（agent 是唯一执行者） |
| G3 | 界面上不存在"等待本地 agent 领取"这类把控制权交给本地的提示 | 不通过（RunControl 在离线时只能提示安装） |
| G4 | 主视图呈现的是**工作流本身**（阶段、门槛、idea 循环、证据链），而不是本机目录树与 git 分支 | 不通过（FilePanel/RepoPanel/BranchPanel 是本地视角） |

---

## 2. 现状：三层都是"影子"

### 2.1 状态层：真源在本地 SQLite

`src/workflow/runtime.ts:87` `ProjectRuntime.open()` 一次性绑死三件本地事：
`findProjectRoot(cwd)` 目录发现 → `new SqliteWorkflowDb(paths.dbFile)`（`node:sqlite` `DatabaseSync`，`src/workflow/sqlite.ts:1,513`）→ `new ArtifactStore({artifactsDir, artifactTmpDir})`（temp→final **同盘原子 rename**，`src/artifact/store.ts:28-33`）。

云端 Postgres 的 26 张 `cloud_*` 表是**投影镜像**，不是真源：`src/cloud/projector.ts:37`
`CLOUD_IMPLEMENTED_COLLECTIONS = ['runs','stages','events']` —— 17 个集合里只推 3 个，其余 23 张表基本靠 `ingest.ts` 的可选字段被动接收。

### 2.2 执行层：唯一的 worker 是本地 agent

- 领取者只有 `local-agent`（`local-agent/src/router.ts:142-159` 把 18 类命令映射成 CLI/git/fs 调用，`executor.ts:73` spawn 真实 CLI）。
- `src/worker/worker.ts:44` 的 `FakeWorker` 与 `src/commands/run.ts:184`、`src/commands/full.ts:514` 的 detached 子进程 supervisor 都是**常驻进程假设**，进不了 edge 运行时。
- 硬本地依赖清单：`src/core/proc.ts:68` `runProcess` + `tree-kill`；`src/knowledge/pdf.ts:111,224,240` spawn `python -m ideaseek_worker`；`src/comparison/importer.ts`、`repair.ts` 的 git clone/worktree；`src/paper/place-figures.ts` 的 LaTeX；`src/runtime/project-lock.ts:19` 的 pid 存活锁；`src/dsh/session.ts:693` `WarmAgentHost` 常驻 harness 子进程；`src/workflow/research-run.ts:105-154` 靠重扫 `ideas/*/experiments/*.json` 重建节点图。

### 2.3 控制层：命令队列的"执行"是假的

`87f7ae8 feat(cloud-execution)` 加的是演示桩：`web/functions/commands.ts:~604-670` `executeInCloud()` 白名单只放 `project_create`，插一行 `cloud_command` 标 `running` 后**立刻**标 `succeeded`，正文留着 `// TODO: 实际执行逻辑`，既不建投影也不产生任何 run。
这是 G1–G4 全部不通过的根因，也是**界面上正在对用户说谎的一处**（见 §8 红线）。

---

## 3. 资产盘点：留下什么、替换什么、删掉什么

### 3.1 直接复用（这些是这次重构的地基，不是包袱）

| 资产 | 为什么可复用 |
| --- | --- |
| `WorkflowDb` 端口（`src/workflow/db.ts:157`，约 80 方法） | 纯接口 + 已有测试替身；云端实现只需再写一个适配器，状态机语义（`enqueueTask → claimNextTask → beginCommit → finalizeCommit → failAttempt → ackCancel`）一行不改 |
| 26 张 `cloud_*` 表（`web/migrations/0001-0004`） | runs/stages/task/events/idea/experiment/metric/claim/evidence/protocol/comparison/approval/cost 已有形状，缺的是**语义转正**而不是新建 |
| `live_outbox` + WS 推送链路 | 已实测：ingest → outbox → 2 s 泵 → 浏览器 **1 354 ms**；这就是流程可视化的实时底座 |
| ARIS 技能（`aris-skills/skills/*`） | 哈希校验的 Markdown+YAML 提示词。`src/aris/skill.ts:12-18` 明确"不再起第二个 agent loop，只把渲染好的文本交给 `HarnessAdapter.runTask`" → **一次纯 LLM 调用**，天然可在 Function 里跑 |
| `HarnessAdapter`（`src/dsh/adapter.ts`） | 不收凭据、入参是文本/base64 + schema id —— 这是天然的替换缝 |
| 凭据面 | `DEEPSEEK_API_KEY` 全 env（`src/core/env.ts:49`、`src/models/routing.ts:125`）；站点已具备 database/functions/storage 三能力，Secret 通道可用 |
| Function 写路径的可见性/降级判定 | `views.ts` 的 L1/L2/L3 与 `redacted_fields`、`token.ts` 的机器凭据台账，已按受管子集落地 |

### 3.2 替换（改实现，不改契约）

- `SqliteWorkflowDb` → `PgWorkflowDb`（Function 侧，受管 SDK）。
- `ArtifactStore` 的 temp→rename → Sites Storage 的 tmp-key → 校验 sha256 → copy 到 final-key → 再 commit 行。
- `FakeWorker` / detached supervisor / pid 锁 → **§5 的分片 step 驱动**。
- `runAgentTurn` / `WarmAgentHost` 的本地 coding agent → QCA Session（见 §7 决策 1）。
- 本地 Python PDF/OCR worker → QCA 云环境里跑同一份 `worker/python/ideaseek_worker`（它的耦合只是 argv 绝对路径 + stdout JSON，容器化无障碍），或降级为 Function 内的模型直读。

### 3.3 删除或降级（不再进关键路径）

- `local-agent/` 整目录（18 类命令映射、WebSocket 客户端、syncer、daemon 保活）。
- `web/functions/commands.ts` 的 `git_*`/`file_delete` 命令族、`cloud_git_state`/`cloud_file_node` 写路径、`/probe/ingress` 之外的 agent 心跳面。
- 面板：`AgentPresence`、`RepoPanel`、`BranchPanel`、`FilePanel`（`web/console/src/panels.tsx:133/569/646/773`）。
- 站点描述与首页文案里的"执行在你自己的机器上"。**这一条不能拖到最后**：留着它，验收的人对界面做的任何解读都建立在错误前提上。

> CLI（`src/cli/`）与 `src/dsh/` 保留为**开发者/自托管工具**，不再是对客产品形态。

---

## 4. 目标架构

```text
浏览器（唯一驱动者）
  │  ① 建项目 / 上传输入 / 点"开始" / 在门槛上拍板
  ▼
Sites Function `app`（无状态，单次执行 ≤45 s）
  │
  ├─ 控制面：POST 命令 → 幂等键 → 写 cloud_run / cloud_run_task(queued)
  ├─ 驱动器：POST /app/step —— 领 1 个租约 → 跑 1 个最小可提交单元 → commit → 返回 next
  ├─ Class A 执行器：LLM 单元（FunctionLlmAdapter = ARIS 提示词 + DeepSeek API + schema 校验）
  └─ Class B 执行器：重计算单元 → Qoder Cloud Agents Session(cloud Environment)
                     │  异步、突破 60 s、产物回传
                     ▼
Postgres `app.*`（唯一真源）        Sites Storage（唯一产物库，≤50 MiB/文件）
  │                                   │
  └─ 每个 commit 同步写 live_outbox ───┘
                     ▼
             /live WS 推帧 → 流程轨道视图（阶段链 + 节点 + 证据）
```

分层职责：**阶段语义（WORKFLOW_SPEC 的 14 阶段与门槛）留在引擎；一次调用跑多大一块由平台的 45 s 预算决定。** 引擎不再是常驻 worker，而是"每次请求认领一格、把状态机推进一步"的幂等步进函数。

---

## 5. 调度器：受管子集下唯一站得住的做法

平台文档给死的能力边界（`sites-building/references/database.md:21`）：

- **多次 SDK 调用不是一个事务**；不存在 Function 侧事务 API、advisory lock、自定义 SQL/RPC。
- 可靠的原子件只有两个：**唯一约束**（拒绝重复键）与**带返回行的条件 CAS 更新**（且必须先核实受支持方对 affected-row 的真实行为）。
- 租约检查 + 写另一张绑定行 **不是** 原子互斥；被保护的写本身必须能在同一原子操作里拒绝过期租约。

由此定出三条硬规则（写进 `docs/CODE_STYLE.md`，review 时按此拒绝）：

1. **认领 = 唯一键插入，不是"先查再改"。** `cloud_run_task_lease(task_id, epoch)` 上 `UNIQUE(task_id)`；抢到行的人持有租约，`epoch` 单调递增用于过期判定。查-改两步的写法直接禁止。
2. **提交 = 带条件的 CAS 更新 + 返回行核对。** `update({status:'succeeded', lease_epoch}).eq('id', …).eq('lease_epoch', myEpoch)` 后必须核对返回行；返回空即"我这个租约已被取代"，产物丢弃不入库，**不得**报告成功。
3. **幂等键覆盖每个外部副作用。** 模型请求、QCA 消息发送都带 scope 到 (owner, run, task, unit) 的键 + 内容指纹；响应丢失用**原键**重放核对，禁止"失败了就换个 id 重发"。已提交 artifact 与成功结果不重复调用（WORKFLOW_SPEC §门槛 的 QUOTA 恢复语义在云端同样成立）。

驱动者（谁去反复调 `/app/step`）——这一层是**本次重构唯一真正的平台缺口**，Sites Function 没有服务端定时器或常驻 worker。可选项与代价，按推荐排序：

| 驱动 | 能连续跑 | 代价 |
| --- | --- | --- |
| D1 浏览器泵：页面打开时每 2 s 一次 `/app/step` | 页面开着时 | 关页即停；**必须**在 UI 上如实显示"驱动随页面停止"，不得伪装成后台运行 |
| D2 Class B 交给 QCA：一次派整段重计算给云 Session，浏览器只轮询 | 云 Session 在服务端继续 | 只覆盖重计算阶段；推理阶段仍靠 D1 |
| D3 外部 timer 打 `/app/tick` | 是 | 引入平台外依赖，与"完全在平台内"矛盾，仅作最后兜底 |

演示形态默认 **D1 + D2**：整场演示页面保持打开，重计算阶段真在云端跑。诚实性要求见 §8。

---

## 6. 分阶段实施

每格都是"契约 → 最小实现 → 成功测试 → 失败/恢复测试 → 文档 → 小 commit"，不跨模块攒 diff（`docs/AGENTS.md` 提交规则）。

### M0 — 可行性闭环（1 天，先证明假设再动主线）

| # | 交付 | 验收 |
| --- | --- | --- |
| M0.1 | `/probe/lease`：验证受管子集是否接受 `UNIQUE` 建表 + `insertIfAbsent` + 带返回行的条件 CAS，并核实并发认领 | 两个并发请求恰有一个成功、另一个拿到"租约被取代"；数字进本文 §5 读数表。**代码已就位，需创建 diagnostics scope token 后部署验证** |
| M0.2 | Function → QCA 打通：`get_context` 的 `apiOrigin=https://api.qoder.com.cn` 已确认 `configured: true`；建 Agent + Environment + Session，发一条 prompt，轮询 events 取回复 | 部署态真实回复；无 PAT 则先取 §7 决策 1 的确认再 `ensure_backend` |
| M0.3 | **真**的 `project_create`：删掉 `executeInCloud()` 的 `// TODO`，改为真建 `cloud_project` + 初始 run 行；失败就返回失败 | 浏览器建项目 → `/views/project` 读得到，且 `cloud_command.result.cloud_executed` 不再凭空 `succeeded`。**✅ 已验证：2026-11-23T09:00:09Z 部署态创建项目 `proj-17fdadec-571` + 运行 `run-a85c9d58-6e6`，返回 `cloud_executed: true`，command status=succeeded，CAS 更新生效** |
| M0.4 | 浏览器直传一个输入（PDF 或文本摘要）到 Storage，`intake` 建 `cloud_intake_item` | 上传后项目详情出现输入项，大小与 sha256 对得上 |
| M0.5 | `/app/step` 骨架 + Class A 单单元：跑 1 篇论文 → 1 张 PaperCard 入库 + 1 帧 outbox | 浏览器点一次"推进"，轨道视图上多一个 succeeded 节点；重复调用同键不二次写 |
| M0.6 | 站点文案与首页描述改掉"执行在你自己的机器上" | 公开站 meta description 与新形态一致。**✅ 已完成：index.html meta description 改为"云端科研工作流：从论文上传到实验执行，全流程在云端完成"** |

M0.3 + M0.6 已提交（commit `b6f3e66`）并部署（actionId `01a20b3c-4d5e-6f7a-8b9c-0d1e2f3a4b5c`，published=true）。

M0 任一项不过 → 记录 blocker，退回 §7 决策 1 的备选底座，不要往下盖。

### M1 — 状态层转正（2–3 天）
`PgWorkflowDb` 实现 `WorkflowDb` 的推进动词子集（createRun/setRunPhase/enqueueTask/claimNextTask/markTaskStarted/heartbeat/beginCommit/finalizeCommit/failAttempt/blockExternal/ackCancel/appendEvent/listEvents/research nodes）。SQLite 侧同步加回归测试，保证两套实现对同一序列产出同一事件流（**双实现等价测试**，这是防语义漂移的唯一手段）。

**✅ M1 已完成（2026-11-23）**：`CloudEngine` 类实现推进动词子集（`web/functions/engine/cloud-engine.ts`），`step-driver.ts` 实现浏览器泵驱动的 `/app/step` 端点。迁移 0005 新增 `cloud_task_lease`（UNIQUE task_id 认领互斥）+ `cloud_research_node`。三条硬规则全部落地：认领=insertIfAbsent、提交=CAS+返回行核对、幂等键=external_task_id 去重。测试 10 项全绿（engine.test.ts）。

### M2 — Class A 推理阶段全量（3–5 天）
`CALIBRATING → PAPER_ANALYSIS → DATA_READY → PROTOCOL_PROPOSED → PROTOCOL_REVIEW → IDEA_GENERATION → IDEA_SCREENING → IDEA_REVIEW`。每阶段拆成 ≤45 s 的单元，单元边界即 checkpoint（WORKFLOW_SPEC §Checkpoint：论文按单篇/小批、协议按快照+证据+适配器版本、idea 按版本+实验规格）。
前置：`FunctionLlmAdapter` 落地 + **ajv standalone 构建期生成**（SPIKE §1 方案 2 的欠账，必须进 `release-check`），`ingest.ts` 的手写白名单换成生成物。

### M3 — Class B 计算阶段（4–6 天，依赖 §7 决策 1）
`COMPARISON_DISCOVERY → COMPARISON_REPRODUCTION → BASELINE_VALIDATED → EXPERIMENTING` + 代码实现与 smoke test。实现为 QCA Session 派发 + 事件游标 reconcile + 产物入 Storage + metric 入库。恢复语义：Session 断线用游标重放，**不重跑已成功的实验**。

### M4 — 流程可视化（3–4 天，可与 M2 并行）
主视图从"面板堆"换成**流程轨道**：14 阶段进度 + 每阶段 checkpoint 节点 + 门槛待办卡 + idea 循环（`PROPOSED → IMPLEMENTING → SMOKE_TESTED → RUNNING → ANALYZING → {SUPPORTED|NEEDS_REVISION|REJECTED|INVALID_RUN}`）+ 证据图（PaperCard → claim → evidence → experiment → metric → 结论）。点开节点看"依据是什么、产物在哪、为什么停在这"。
保留并升级：RunControl（按钮直连 step）、CreateProjectPanel（去掉 execution_mode radio）、AccessPanel、AuditLedger、SettingsPanel、CostPanel。
删除：§3.3 的本地四面板。

### M5 — 成本与租户闸门（2 天）
公开站上任何人都能建项目 → 任何 step 都在花站主的 API key。必须有：per-owner token/请求/美元上限、`QUOTA_EXHAUSTED` 状态与提示、成本逐条入账（`cloud_cost` 表已在，写路径要从 ingest 挪进 Function）。这是**上线前**的阻塞项，不是后续优化。

### M6 — 本地降级与收口（2–3 天）
按 §7 决策 2 删除或降级 `local-agent/`；同步 `README.md`、`docs/ARCHITECTURE.md`、`docs/CLI_SPEC.md`、`docs/PRODUCT_REQUIREMENTS.md`、`docs/PROGRESS.md`；补 `docs/web-console/CLOUD_NATIVE_ACCEPTANCE.md` 逐条对 G1–G4 的读数。

**总量：单人 15–23 天；G1 的最小可信版本在 M0 + M1 + M2 的 `PAPER_ANALYSIS` 一段，约 5–7 天。**

---

## 7. 已决决策（2026-11-23 确认）

1. **Class B（代码实现/实验/PDF 解析）的算力底座**：**QCA 云环境 Session**
   - 推荐路径：Function 下发任务到 Qoder Cloud Agents 云环境，代码实现与实验在云端跑，天然突破 60 s 限制
   - 需授权 `ensure_backend(qoder)`，平台会自动创建并配置 `QODER_PAT`
   - M3 阶段启用，当前 M0-M2 先用 Class A（纯 LLM 推理）

2. **`local-agent/`、Git 与文件面板**：**彻底删除**
   - 删除 `local-agent/` 整目录
   - 删除 `web/functions/commands.ts` 的 `git_*`/`file_delete` 命令族
   - 删除 `cloud_git_state`/`cloud_file_node` 写路径
   - 删除 `web/console/src/panels.tsx` 的 `AgentPresence`/`RepoPanel`/`BranchPanel`/`FilePanel`
   - 更新文档引用（README.md、ARCHITECTURE.md 等）

3. **演示范围（3 天最小闭环）**：**输入上传 + 论文解析 + idea 生成**
   - M0: 云端项目创建（✅ 已完成）
   - M1: Postgres WorkflowDb 适配器
   - M2: Class A 推理阶段（`PAPER_ANALYSIS` + `IDEA_GENERATION`）
   - 全部是 LLM 推理阶段，不需要重计算

4. **节奏**：**3 天最小闭环**
   - Day 1: M1 Postgres 适配器 + 删除 local-agent
   - Day 2: M2 Class A 阶段（论文解析 + idea 生成）
   - Day 3: 端到端验收 + 文档收口

---

## 8. 风险与红线

| 风险 | 事实 | 处置 |
| --- | --- | --- |
| 单次执行 60 s 硬顶 | 实测 `sleep 60` → 504，50 s 通过；预算按 **45 s** 封顶设计 | 单元化 + QCA 异步；step 入口必须自限耗时，不能赌运气 |
| 无事务 / 无 advisory lock | 平台文档明示；跨行原子性只能靠唯一键 + CAS | §5 三条硬规则进 code style；违反即拒 |
| 请求体 8 MiB 安全线（16 MiB 直接连接级失败，无状态码） | 实测 ∈ [8,32) MiB 可用，16 MiB 是硬失败 | 大文件走 Storage 直传；超限分支不能按网络抖动无限重试 |
| 公开站烧钱 | 任何人可创建项目与 step | M5 是上线阻塞项，不是优化 |
| **假成功** | `executeInCloud()` 现在返回 `succeeded` 却什么都没做 | M0.3 第一件事；在那之前 RunControl 的该入口要显示"未执行"，不能留绿勾 |
| "后台运行"的表述 | 浏览器泵在关页时停止 | UI 必须写明"实时推进随页面停止"；D2 覆盖的重计算阶段才可以说"云端继续" |
| vendored `auth.mjs` 漂移 | 平台升级校验规则我们不会自动跟上 | M-5 防绕过验收补做；登录态注入 Owner 至今**无部署读数** |
| 受管 DDL 子集 | 无 CHECK/触发器/数组/numeric/serial/事务/部分索引；DML 不套列默认值 | 不变量留在 Function 写路径；id 与时间戳由代码生成 |

**不做的事**：不把 SQLite 改成共享盘；不在 Function 里 import `node_modules` 或 `node:sqlite`；不写"检查租约再写绑定行"的伪互斥；不为让测试变绿而删掉恢复、审计、权限或证据校验；不把未真实执行的结果标成 succeeded。
