# IdeaSeek 用户旅程验收

这份文档用完全不了解内部架构的新用户模拟一次完整使用。每一步都必须让用户知道当前状态、下一步、预计成本、如何暂停和如何恢复。

## Journey A：空目录首次使用

```text
安装 → ideaseek doctor → ideaseek init → ideaseek start
```

验收：

- 安装命令能确认版本、平台和 DSH runtime；
- `doctor` 用人话说明缺少什么，不打印 secret；
- `init` 幂等，不覆盖已有文件；
- `start` 能发现空项目并提示最小输入；
- 用户能看到一个 demo/fixture 入口，不必先准备真实论文；
- `next` 给出下一条可复制命令。

## 项目上下文

IdeaSeek 采用“当前目录就是项目”的默认模型，类似 Claude Code：

```bash
cd ~/research/fl-model-heterogeneity
ideaseek
ideaseek status
```

CLI 从当前目录向上查找 `.research/` 项目标识；`/status`、`/next`、`/papers`、`/ideas` 和交互中的自然语言默认只作用于当前项目。没有项目上下文时，命令不猜测最近项目，而是提示 `ideaseek init`、`ideaseek projects` 或显式指定项目。

用户也可以从任意目录查看和打开历史项目：

```bash
ideaseek projects
ideaseek open ~/research/fl-model-heterogeneity
ideaseek status --project ~/research/fl-model-heterogeneity
ideaseek attach --project ~/research/fl-model-heterogeneity --run <run-id>
```

`open` 只切换当前 CLI 的项目上下文，不复制或移动项目文件；交互 REPL 中显示当前项目路径和 project ID，避免把命令发到错误项目。后台 run 继续绑定创建它的项目目录，不能因为用户从另一个目录 attach 就改变其输入根。

## Journey B：模型配置

```text
ideaseek → /models → provider/route/model → 隐藏输入 key → test
```

验收：

- 显示 fast/balanced/deep/deterministic 路由和每个 role 的绑定；
- key 只写入 DSH credential store/secret manager；
- 测试失败说明 endpoint、权限、额度或工具能力问题；
- provider 切换不影响已有 run snapshot；
- `models --json` 完全脱敏。

## Journey C：输入论文、代码和数据

```text
放入 papers/datasets/comparisons/incoming
→ ideaseek scan
→ ideaseek intake
→ ideaseek plan --question "..."
```

验收：

- 用户不需要理解 PaperCard、manifest 或 Agent 拓扑；
- 扫描结果按论文、数据、代码、补充材料和歧义分组；
- 识别出重复文件和可能的 comparison 关联；
- 原始文件不移动、不覆盖；
- 计划显示论文数、数据集数、comparison、idea 上限、预计 token/GPU/磁盘；
- 用户能只确认协议歧义，不必确认每个文件。

## Journey D：协议确认与第一次运行

```text
ideaseek start --question "..."
→ 论文分析
→ 数据画像
→ ProtocolProposal
→ 用户确认
→ comparison gate
→ quick 实验
```

验收：

- 终端显示阶段、Agent、任务进度、预算和阻塞；
- 高影响协议变更显示候选、依据、影响和成本；
- `guided` 模式不会静默锁定关键科学语义；
- `starter` 模式在少量论文/单数据集时能得到初步候选，但降低结论等级；
- comparison 未通过时明确停在 comparison gate，不假装进入 idea 阶段。

## Journey E：交互式科研过程

在 `ideaseek ›` 中同时支持命令和自然语言：

```text
/status
为什么 method-b 还没通过？
优先验证 idea-002。
/pause
```

验收：

- 查询类自然语言直接回答并引用状态；
- 改变优先级、预算、comparison、idea 或协议的请求转为待审批 Decision；
- 用户可以暂停一个 idea 而不停止兄弟 idea；
- `--plain`、`--json` 和交互模式语义一致；
- 不显示隐藏思维、完整 prompt 或 secret。

## Journey F：长任务、断线和额度耗尽

```text
start --detach → SSH 断开 → supervisor 继续
→ QUOTA_EXHAUSTED/机器重启/GPU OOM
→ doctor → continue/attach
```

验收：

- 事件、心跳、任务租约和 checkpoint 持久化；
- 已完成论文、comparison、idea 版本和实验结果不重做；
- 额度耗尽不会被标成科学失败；
- GPU OOM 不会被解释成 idea 被否证；
- 用户能看到最后心跳、失败原因、恢复点和预计成本；
- 备份恢复后 artifact hash 和任务状态一致。

## Journey G：idea 迭代与 handoff

```text
idea proposal → code → quick/standard → ablation → Result Analyst
→ revise 或新 idea → HANDOFF_READY
→ export/handoff
```

验收：

- 工程修改产生同一 idea 的新版本；科学假设变化产生新 idea；
- 每个实验能定位到 code/data/protocol/idea version；
- 失败实验永久保留；
- handoff 包含 full-scale 配置、split、环境、命令、资源和风险；
- 只有达到证据门槛才标记 `HANDOFF_READY`；
- 报告区分探索证据和用户自行完成的全量结果。

## Journey H：更新、归档和恢复

```text
ideaseek update → migration preview → backup → upgrade
ideaseek archive/export → 另一台 Linux → restore → doctor → continue
```

验收：

- 配置和数据库迁移有 preview、备份和回滚；
- 旧 run 可读；
- 项目可导出而不包含 secret；
- 另一台机器恢复时验证 DSH、Python、容器、GPU 和 artifact hash；
- 输入/模型/代码版本变化只使依赖图上的下游失效。

## 实施状态（2026-11-13，append-only）

> 服务器实机执行计划见 [ACCEPTANCE_SERVER.md](ACCEPTANCE_SERVER.md)（gitee 为协作主干：服务器 agent 自测/有界自修/推送，证据 append-only 于 `docs/ACCEPTANCE_EVIDENCE.md`，本地 agent 拉取审查后同步 github）。

自动化验收：`tests/journey-acceptance.test.ts`（4 条）+ 既有套件覆盖——

- **Journey A ✅（自动）**：`--version` 对齐 package 版本；`doctor` 空目录人话提示 init、零 secret；`init` 幂等（already initialized）；`start` 空项目给出最小输入与可复制 `next:`。当前安装通道为 source build；最终可复现发行包的分发渠道（npm、私有 Git 或实验室镜像）尚未决定，不把公开 npm 发布作为产品前置。
- **Journey B ✅（自动）**：`models list` 显示 fast/balanced/deep/deterministic 四层与角色绑定、凭据只报 presence；`models list --json` 可解析且 `sk-`/`ghp_` 零命中。
- **Journey C ✅（自动）**：论文/数据/comparison/歧义分组、重复内容识别、原始文件字节不变；`plan --question --json` 给出 paperFiles/manifestFiles/comparisons/ideas.limit/model.route 且为 dry-run。
- **Journey E ✅（自动，非交互核心）**：run 存在时 `ask` 查询有回答；高影响 ask 落 pending/Decision 且 `idea list` 无副作用；`--plain/--json` 脱敏由既有 interactive/models 套件覆盖（REPL 交互面见 repl-ux/interactive）。
- **Journey D ◐**：starter 管线、协议 propose→confirm→lock、comparison gate 停滞均有 e2e（protocol/inputs/cli.start/gate 测试）；端到端“一次真实 start→quick 实验”演示链由 cli.start + demo pipeline 测试覆盖，真实模型链待凭据批量回归。
- **Journey F ◐**：事件/租约/checkpoint/崩溃恢复/额度阻断有 soak、supervisor、cli.e2e、quota 测试；“备份恢复后 hash 一致”依赖 restore 工具（见 Journey H/备份恢复待办）。
- **Journey G ◐**：工程 vs 科学分支、失败保留、handoff 门禁与 PROMISING 拒绝均有测试（revision-loop/handoff）；真实 HANDOFF_READY 需要真实证据门槛（研究项，非本套件可伪造）。
- **Journey H ⏳**：`ideaseek update`/迁移 preview/跨机 restore 工具未建（Phase 9 备份恢复 checkbox）；export 脱敏与迁移 schema 已有基础（maintenance/config）。
- **2026-11-14 追加状态（D → ✅ 真实模型链接受凭据验收）**：本机配置真实 DeepSeek key 后——keyed 批量回归 tests/dsh-keyed+dsh-adapter+extract **16/16 全过（真实模型调用，非 skip）**；真实语料链：复制 FedAvg 原文 PDF → scan/ingest（真实解析）→ `extract --harness dsh` 真实出 PaperCard（2 任务成功）→ `protocol propose --harness dsh` 真实提案 → `confirm protocol` **锁定 proto-cd92ffef2e65-v1**（低置信项如实浮出 confirmations）。G（真实研究证据）与 H（跨机 restore）仍为服务器/研究项。
- **2026-11-13 追加状态**：Journey F 的“备份恢复后 hash 一致”已闭合（backup-restore 演练：manifest 逐文件哈希复核、篡改零写入）；Journey H 的工具缺口已闭合——`ideaseek update`（源链接重建+manifest 幂等刷新）、迁移 preview（doctor schema vN/vM）、restore 含跨路径 rebind，余跨机实机验证。D（真实模型链凭据批量回归）与 G（真实 HANDOFF_READY 证据门槛，研究项不可伪造）保持 ◐。整体 A–H 验收仍未全绿（D/G/H 实机与凭据缺口）。

- **2026-11-19 追加状态（本机手动新用户走查 A/B/C/H 本地腿）**：**A ✅ 手动复走**——`--version`/`doctor`（人话、零 secret、缺项目给准确 next）/`init` 幂等/`start` 空项目提示齐全；**抓到并修复两个真实缺陷**：①`next` 建议 `plan --question`（”写下研究问题，即时配置操作”）但 plan 是 documented dry-run（--question 不持久化）→ 照做后阻塞原样、建议重复 = 死循环，违反本节产品规则——gap fillIn（assessment 输出与 agent 候选集的共同源）改指 `setup --question`，start 无问题 fallback 同改，三处回归用例钉死（assessment fillIn、next 候选含 setup 不含 plan、journey-acceptance 负断言），修复后手动复走：next → setup（写入 research.yaml 带备份）→ question 阻塞消失 → 推进到 papers 建议；②空项目 `start` 指导未露出 demo 入口（验收要求”用户能看到 demo/fixture 入口”，原先只在 README）→ guidance 补 `ideaseek run --question “...”（demo 流水线，不需要论文）`。**B ✅ 手动**：四层路由+角色绑定齐全、凭据 presence-only、`models list --json` 对 `sk-`/`ghp_`/Bearer 零命中。**C ✅ 手动**：scan/intake/plan 输出均人话且给可复制 next；plan 诚实标注 dry-run（`questionPersisted:false`，估算 basis 写明 “not a provider quote”/”budget ceiling”）。**H 本地腿 ✅ 手动**：`backup`（sha256 manifest）→ 全新目录 `restore`（逐文件 hash 校验、跨路径 rebind）→ `doctor` ok=21/warn=0/error=0 → `status` 可读并给出推进命令；**跨机（另一台 Linux）腿待 GPU 服务器实机**（ModelScope 免费额度已确认方向）。F 机械面由 soak/supervisor/quota 测试覆盖（今日未手动复走 detach）；D 真实模型链 11-14 已凭据验收（今日未做 fresh 全链）；G 仍为研究项（真实证据门槛不可伪造）。
- **2026-11-20 追加状态（服务器实机验收完成，DSW-GPU，执行者=服务器 agent 有界自主）**：14 STAGE 全执行——**13 PASS + 1 PARTIAL**（STAGE 12 full-run：科学门禁如实拦截——新 idea quick 与同跑对照打平 → verdict inconclusive → 拒绝放行；**非平台缺陷**）；阶段内 SKIP 4 处均有替代证据（fdg-backup 上传、SSH 断连→detach 等价、TUI slash relay→interactive lane 24 用例、coding 真实 turn→计划允许）。**缺口闭合：D ✅**（真实模型链 STAGE 3/4/11：协议 proto-bbae9031fbbd-v1 锁定、真模型一次生成 3 卡）、**H 跨机腿 ✅**（STAGE 6 backup→restore 在另一台 Linux 实机通过；仅 fdg-backup 上传子项 SKIP）；**G 仍为研究项**（真实 HANDOFF_READY 证据被同一科学门禁挡在前面）。服务器 agent 有界自修 **I9–I22**（14 个缺陷：协议 prompt 源枚举/包装形状、数据集断点续传 378MiB、>256MiB link 台账哈希、python venv 自举、latexmk 缺失=blocked、harness 继承、生成契约 step 形状……全部改→回归→绿→推送）。**验收末轮三 lane 全绿**：205 文件/1905 测试 → **1903 passed / 2 skipped / 0 failed** + 交互 24/24 + python 23 OK（f217fc8）；本地复扫铁律：无测试删除、无疑似凭据入 diff。**机器侧上线意见：主研究链全链 PASS、全部门禁反面场景真实拦截无假绿 → 可上线（source-build 形态）**；遗留如实标注：full-run 字面执行待"打赢对照的假设"（研究项）、多卡待多卡资源、npm 分发待发布账号、运行风险=网络重负载与外部源质量。

## Journey I：Web 控制台远程观测

```text
手机/浏览器打开 https://<site>.qoder.site
→ 落地页 → 演示项目 → 登录 → 自己的项目
→ 查看运行状态/阶段/事件/成本/审批
→ 提交审批意向 → 本地 ideaseek cloud pull 生效
```

验收：

- **F6.1-F6.5 落地页**：Hero 区块、差异化定位、公开项目入口、快速开始、隐私承诺；匿名访客 3 步内看到演示项目（F7.3）；
- **F2.1-F2.5 项目详情**：项目标题/可见性徽标/策略/自主度；运行状态 chip（SUCCEEDED/RUNNING/PAUSED/QUOTA_EXHAUSTED 等九值不翻译 NFR-12）；阻塞原因卡（F2.4 科学失败 vs 基础设施阻塞视觉分离；F2.5 下一步建议指向 `ideaseek doctor/continue`）；
- **F3.1-F3.4 阶段流水线**：14 阶段严格对齐 `WORKFLOW_SPEC.md:5-21`（不增删改名 NFR-12）；五态渲染（pending/active/blocked/passed/failed）；可折叠门槛说明；`stage_known=false` 显式标"未上报"而非静默抹平；
- **F4.1-F4.4 事件时间线**：按 seq 倒序分页；三过滤器（stage/type/level）；截断标记"…（已截断）"；批更新标注"数据来自 x 分钟前的一批同步"（**禁用"实时"字样 R3**）；缺口显式标"N 条事件未同步"而非安静展示更短的时间线；
- **F5.1-F5.9 可见性三级**：private/link/listed 语义递进（Q1）；L2 降级投影逐字段构造（不是"少选了列"）；`redacted_fields` 列表诚实标注降了什么；列表确认闸门 F5.9（进公开列表必须第二次独立确认）；
- **F8.1-F8.6 Idea 看板**：三列布局（有效候选/草稿拼接/已拒绝）；DRAFT_COMPOSITION 灰显不与有效候选混排；假设全文按 `hypothesis_disclosure` 分级（withheld/structure/full）；结论徽章四色（SUPPORTED/NEEDS_REVISION/REJECTED/INVALID_RUN，INVALID_RUN 不算否证）；版本树递归渲染 `parent_idea_id` 链；
- **F9.1-F9.4 证据链追溯**：论文卡片列表（失败论文标出而非消失 `WORKFLOW_SPEC.md:32`）；claim → 页码定位；缺失出处显示"未确认"而非空白或猜测；
- **F10.1-F10.4 实验结果与协议**：指标表（主/辅指标、方差、方向）；数据规模标签醒目（smoke/quick/standard/handoff_manifest，handoff_manifest 标"未执行" NFR-13）；协议详情（锁定状态/规则来源）；
- **F11.1-F11.6 审批信箱**：跨项目聚合 pending 审批；审批详情（原因/选项/影响范围/来源事件）；提交意向文案固定"待本地确认"（**永不显示"已批准/已生效" R2 云端不落执行**）；冲突意向并列（F11.4 多个审批人选不同选项全部列出，不自动合并）；intent 生命周期三态（submitted/delivered/consumed）；
- **F12.1-F12.5 成本与额度**：花费汇总（token 数/USD micro）；预算进度条（接近 80% 高亮）；重复成本标记（同 route+kind 多次出现）；按模型路由分布图；额度耗尽引导（指向 `ideaseek doctor → continue`，与 F2.5 联动）；
- **F13.1-F13.3 外发台账**：按 run 聚合（目标类别/数据类别/次数/字节）；**缺口⑫只有类别与计数无 prompt 正文**；引擎未产生数据时显式说明而非安静显示空表格；
- **F16.1-F16.2 Token 管理**：列表/创建/吊销（只存哈希 NFR-02，明文只显示一次）；同步健康面板（最近批次状态/待处理批次数/拒绝原因分布）；
- **F17.1-F17.6 推送通道**：WebSocket 优先 + 15s 轮询兜底（S6 降级方案）；指数退避重连 1→30s 封顶 + 抖动；重连成功后先 REST 全量再收增量（F17.5）；后台标签页停推（F17.6 `visibilitychange=hidden`）；
- **F15.1-F15.5 移动适配**：768px 断点（表格降级卡片/流水线横向滚动/过滤器垂直堆叠）；360px 断点（字号缩小/padding 缩小）；
- **安全纪律**：匿名访客审批/token 返回空数组不报错；L2 用户看不到成本/审批/外发/token（L1 字段）；所有文案无"实时"字样（R3）；sync_token 只存哈希（NFR-02）；审批只写意向不触发执行（R2）。

**实施状态（2026-11-23）**：

- **M1–M6 前端全部交付**：`web/console/src/` 包含 Landing/Project/ApprovalInbox/CostDashboard/EgressLedger/TokenManager 等组件；`web/functions/` 包含 8 条读路径 + 3 个写集合 ingest；`tsc --noEmit` 零错误；
- **M1 部署验证**：S1–S6 spike 完成，26 张 `cloud_*` 表经受管迁移建成，WS 握手 101 成功，`/live` 推送 1354ms 到达；
- **M4 公开访问**：落地页 + 演示项目 + 可见性三级 + 移动适配；
- **待验收**：真实长任务联调（需真实研究项目跑完全链）；schema 漂移演练（M7 后半段）；登录态注入 `x-qoder-user-context` 真实走通（M1 登记未修）。

未通过项的阻塞性质：H/F 的 restore 工具（可开发）、G 的真实证据门槛（需真实研究）、npm 安装通道（需发布账号）。产品规则复验：以上自动项均断言”有下一步命令、无 secret、无静默副作用”。

## 发现问题时的产品规则

如果用户必须阅读源代码、猜内部状态、手工修数据库、手工清缓存、重新运行已完成任务，或不知道下一步命令，该旅程不算通过。
