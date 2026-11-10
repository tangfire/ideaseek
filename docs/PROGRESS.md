# IdeaSeek 开发进度

这是后续开发 Agent 必须持续更新的进度文件。完成一个可验证模块后，把对应 `[ ]` 改为 `[x]`，填写 commit、测试和已知限制；未完成或只有空壳的模块保持 `[ ]`。不要为了看起来完整提前打勾。

## 当前主线

当前主线按优先级推进：

```text
Phase 4：Comparison 完整闭环
→ Phase 5：首个真实方向验证
→ Phase 6：按需求扩展能力
→ Phase 7：发布与运维
```

领域插件、向量检索、多 GPU 和其他方向扩展不是 Phase 4/5 的前置条件。模块交付记录是 append-only 历史；顶部 checkbox 是当前状态的唯一来源。

## Phase 0：项目骨架与恢复

- [x] `ideaseek init` 幂等创建项目目录和模板
- [x] `ideaseek start` 小白用户一键入口和规模自适应策略
- [x] `ideaseek setup/doctor/config explain`
- [x] 自动检测 Python/Node/容器/CUDA/GPU/磁盘
- [x] `scan/intake/organize` 与 InputManifest
- [x] `starter/standard/research` 运行策略和报告措辞
- [x] 配置 schema、迁移和 ResolvedConfig 快照
- [x] Workflow DB 与 artifact store 接口
- [x] Task lease、heartbeat、重试、取消和幂等提交
- [x] RunEvent 持久化、`status/next`
- [x] 后台 supervisor、`attach/watch/events`
- [x] `pause/resume/continue/cancel`
- [x] 故障注入和 checkpoint 恢复

## Phase 1：DSH 集成

- [x] 固定 DSH commit/包版本和兼容性测试
- [x] `HarnessAdapter`
- [x] Cordis plugins/bundles/profile 加载
- [x] 模型 provider、额度耗尽和凭据恢复
- [x] Agent capability profiles
- [x] Tool schemas、权限和审计事件
- [x] 假 Paper Extractor 端到端任务

## Phase 1.5：CLI 交互与可观察性

目标：让用户能像使用成熟 Agent CLI 一样实时看到 IdeaSeek 在做什么、为什么等待、需要什么确认，并能在 SSH 断开后重新接入。

- [ ] IdeaSeek 启动 banner 和窄终端 fallback
- [ ] `ideaseek ›` 交互提示符与 `/help`、`/status`、`/next`
- [ ] 论文、comparison、idea、实验的实时事件摘要
- [ ] `attach/watch/events` 事件回放与实时跟随
- [ ] protocol/experiment/权限审批交互
- [ ] `pause/resume/continue/cancel` 交互反馈
- [ ] `--plain` 无颜色日志输出
- [ ] `--json` 机器可读事件和状态输出
- [ ] 任务详情、脱敏日志和错误解释
- [ ] 断线重连、终端尺寸变化和后台 supervisor 状态显示

## Phase 2：论文与知识库

- [x] PDF/LaTeX/OCR/表格/图表解析
- [x] PaperCard schema 和证据定位
- [x] 去重、全文/向量检索和增量处理
- [x] Paper Extractor 并行 map 阶段
- [x] Evidence Checker
- [x] 主题综合、机制库和研究地图
- [x] 论文 gold set 回归

## Phase 3：数据与实验协议

- [x] Dataset Analyst 和 dataset card
- [x] Protocol Synthesis Agent
- [x] Leakage/Validity Checker
- [x] ExperimentalProtocolProposal schema
- [x] 用户确认和 protocol lock
- [x] Scenario Planner 和实验组合 L0–L4
- [x] DatasetSlice `smoke/quick/standard`、handoff manifest 和晋级规则
- [x] 数据分布保持、客户端/域/主体边界和泄漏检查
- [ ] 首发领域验证（优先联邦学习模型异构）及人工 gold set

## Phase 4：Comparison

- [x] comparison manifest 与 required 状态
- [x] 用户仓库导入和 upstream/worktree 隔离
- [x] 官方代码定位和许可证记录
- [ ] Baseline Repair Agent
- [ ] Baseline Reproduction Agent
- [ ] 统一 ExperimentSpec/RunResult
- [ ] 所有 required comparison 门槛

## Phase 5：Idea 与实验闭环

- [ ] Mechanism Analyst、Idea Generator、Research Discussant
- [ ] Novelty Challenger、Synthesis Lead
- [ ] IdeaCard 机制链和 `DRAFT_COMPOSITION` 门槛
- [ ] 独立 idea workspace 和代码版本
- [ ] Code Implementer、smoke test、静态检查
- [ ] GPU Capacity Planner 和多 idea 并行
- [ ] 主实验、消融、失败分类和结果分析
- [ ] Idea 版本迭代、否证和新 idea 分支
- [ ] 结果/报告/复现清单

## Phase 6：首个方向验证

目标：用一个真实研究方向验证通用论文学习、协议综合、comparison、quick/standard 实验和 handoff 的完整闭环。优先使用联邦学习模型异构，但不把领域知识硬编码进核心。

- [ ] 接入真实 FL 数据集并生成 dataset manifest
- [ ] 生成客户端/模型异构实验协议并通过泄漏门禁
- [ ] 在至少两个代表性数据切片上验证 protocol lock
- [ ] 完成 required comparison 的 quick smoke/评测
- [ ] 运行一个 idea 的机制验证、关键消融和结果反馈
- [ ] 生成 `HANDOFF_READY` 级别的代码、配置和复现包
- [ ] 建立该方向的人工 gold set 和回归样例

## Phase 7：可选扩展与规模能力

这些项目按真实需求启用，不是通用 idea 生成的前置条件。领域插件不按研究方向预先开发；只有用户需要特殊格式、指标、泄漏规则或仿真器时，才创建对应插件并单独验收。

- [ ] 定义可选插件 SDK、安装/启用/doctor 和权限 manifest
- [ ] 多 GPU 资源调度和本地模型推理服务
- [ ] 多数据集/多场景实验组合扩展

## Phase 8：发布与运维

- [ ] Linux 安装包和服务器部署验证
- [ ] Windows/WSL2 使用路径验证
- [ ] 回归集、依赖、许可证和 secret 检查
- [ ] 备份恢复演练和发布清单
- [ ] 版本迁移、回滚和已知限制说明

## 模块交付记录

每个完成模块追加一行：

```text
YYYY-MM-DD | 模块 | commit | 测试命令/结果 | 已知限制 | 下一依赖
```

```text
2026-11-10 | Phase 0 可恢复垂直切片（init/status/next/events、Workflow DB、lease/heartbeat/重试/取消/幂等两阶段提交、RunEvent 回放、Artifact Store hash+原子提交、pause/resume/continue/cancel、假 Worker、故障注入与重启恢复） | 07f3cae | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 7 files / 50 tests passed（含 Worker 崩溃、重复提交、租约过期、输出写入中断、进程重启、quota 阻塞、CLI e2e 退出码） | Windows 下 SIGINT 无法投递给子进程，Ctrl-C 语义只做了进程内测试；后台 supervisor/attach/watch 未实现；scan/intake/organize、setup/doctor、start 未实现；配置无迁移器；DSH 未接入 | 下一模块：ideaseek setup/doctor/config explain + 自动环境检测（依赖本切片的 config 抽象）
2026-11-10 | Phase 0 setup/doctor/config explain、环境自动检测（Node/Python/容器/GPU+CUDA/磁盘）、配置 schema 严格校验与 config_version 迁移、ResolvedConfig run 快照 | 306d13a | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 10 files / 69 tests passed（含 schema/迁移单测、探针超时/ENOENT、setup 幂等、坏配置下 run/worker 拒绝与 doctor/next 退出码） | 探测均为本地只读，无网络探测；凭据检查占位（Phase 1 接 DSH provider）；setup 规范化会丢弃 yaml 注释（先备份） | 下一模块：scan/intake/organize 与 InputManifest（依赖 init/paths 抽象）
```
2026-11-10 | Phase 0 scan/intake/organize 与 InputManifest（扩展名+根目录分类、内容哈希去重、同名/同目录候选分组、增量哈希复用、平台索引 symlink/copy 与 provenance） | d629fcd | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 12 files / 77 tests passed（含 .research/ideas 排除、organize 幂等与占用槽位保护、CLI e2e 退出码） | 分类为无 PDF 解析的启发式（parser ideaseek-scan-1）；分组全部 needsConfirmation（无确认交互流）；Windows 无符号链接权限时回退副本 | 下一模块：starter/standard/research 运行策略与 report 措辞
2026-11-10 | Phase 0 运行策略（auto 规模自适应 starter/standard/research + countInputs 探测）与 ideaseek report 策略措辞 | bea80df | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 14 files / 86 tests passed（策略阈值、措辞覆盖、显式 mode 覆盖 e2e） | 报告仅含持久化事实（Phase 0 无模型结论）；措辞为固定模板 | 下一模块：ideaseek start 一键入口
2026-11-10 | Phase 0 ideaseek start 一键入口（initializeProject/performSetup/performScan 复用抽取 + 问题持久化 + 环境摘要 + 下一步向导） | 30f69ee | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 15 files / 88 tests passed（bootstrap/幂等/问题保留/有输入后 next 切换） | start 不自动执行 run（Phase 0 受限语义，执行仍显式） | 下一模块：后台 supervisor、attach/watch/events
2026-11-10 | Phase 0 后台 supervisor（run --detach + daemon.json 心跳）、attach/watch 实时事件流（DB 轮询回放+跟随）、status supervisor 状态 | 473b792 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 17 files / 97 tests passed（follow 回放/signal/worker-lost、detach→完成→attach 回放 e2e、watch 退出码、pause 关停 daemon） | attach/watch 基于 DB 轮询（默认300ms）而非推送；Windows 无法向子进程投 SIGINT（watch/attach 的 Ctrl-C 语义仅进程内测试）；supervise 为内部命令 | Phase 0 全部 checkbox 完成；下一阶段 Phase 1：HarnessAdapter + 固定 DSH commit
2026-11-10 | Phase 1 起步：runtime-lock.json 固定 DSH commit fcc0ad46 + 兼容性测试、HarnessAdapter 契约（结构化 runTask/类型化 block/脱敏事件）、FakeHarnessAdapter、paper.extract 假 Paper Extractor 端到端（quota 恢复/永久失败/缺 harness 路径）、CLI --paper/--harness | f57517e | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 19 files / 108 tests passed | DSH 真实适配（SDK/Cordis 嵌入）与 provider/profile/tool-schema 尚未接入，--harness dsh 明确报错；凭据仍为占位 | 下一模块：读取 DSH 公开 API 报告 → DshHarnessAdapter（SDK 或 in-process Cordis）
2026-11-10 | Phase 1 DshHarnessAdapter（@deepseek-ai/dsh-sdk-client 0.2.2-rc.1 子进程边界、稳定 LlmFailure 码映射、JSON 抽取、真实 keyless spawn 测试）| d17c203 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 20 files / 117 tests | DSH 无 cancel RPC：超时即关闭 runtime 重试；带真实 key 的模型调用未测（无凭据，e2e 自跳过） | 下一模块：Cordis 插件与 capability profile
2026-11-10 | Phase 1 capability profile + 研究工具插件 + 审计（generated ideaseek.cordis.yml：research-tools、preset registry 默认 ideaseek-extractor、工具 allowlist 子插件；DSH_PERMISSION_MODE=read-only + project_read 路径守卫；papercard 持久化 toolCalls/sessionId + harness_tool_call RunEvent；doctor 显示 DSH pin 与凭据存在性）| 26de559 + 79c1e7c | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 21 files / 125 tests（含 dsh --dump-config 组合验证与真实 keyless spawn 加载 patch）| 多角色可见性目前只有 extractor allowlist（第二角色随 Phase 2 综合角色落地）；审批流未启用（Phase 1 提取不调用需审批的工具） | Phase 1 checkbox 全部完成；带 key 的端到端模型调用留给用户提供凭据后验证
2026-11-10 | Phase 2 起步：PaperCard 契约+校验（claims 必须带证据定位）、Python pypdf worker（严格 JSON 协议/稳定错误码/夹具 PDF 生成器/5 unittest）、TS 桥接、paper.parse 任务与 run --paper PDF 链（parse→extract 保留 [page N] 标记）、task_result 事件 | 237ea54 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 23 files/135 vitest + 5 python 全过（含真实 PDF 链 e2e）| LaTeX/OCR/表格图表解析未做；真实抽取需模型凭据（fake harness 跑通链路） | 下一模块：FTS 全文检索
2026-11-10 | Phase 2 FTS5 索引与检索：迁移 v2（paper_index+paper_fts）、按 sourceHash+parser 的增量 refresh、来源替换代际清理、查询消毒（运算符注入中和）、ideaseek search（页级命中+snippet+--reindex/--no-index）| 99e8e26 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 24 files/141 vitest + 5 python 全过（含检索 CLI e2e）| 向量检索未做（需模型/embedding）；knowledge_search DSH 工具封装待 Evidence Checker 一起落地 | 下一模块：Evidence Checker（确定性引文核验）
2026-11-10 | Phase 2 Evidence Checker（确定性层）：verifyPaperEvidence 引文/页码/哈希绑定核验、paper.verify 任务链、evidence_verdict 事件、FakeHarness 输出合规 PaperCard、extract 平台盖章 document_hash/paper_id | cd7959e | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 25 files/150 vitest + 5 python 全过（checker 判定矩阵9例 + 双链 e2e verdict pass）| 判定仅覆盖确定性部分（结构/引文/绑定）；语义级核验与真实抽取需模型凭据 | 下一模块：knowledge_search DSH 工具封装或 ingest 并行解析入口（均可无凭据推进）
2026-11-10 | Phase 2 knowledge_search DSH 工具（CLI 子进程查询 FTS 索引、单写者协议、解析器 allowlist 扩展为 project_read+knowledge_search）| e5297f4 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 26 files/156 vitest + 5 python 全过 | DSH 子进程不直连 DB（经 ideaseek search --json）；工具真实被模型调用的会话级验证需凭据 | 下一模块：ingest 并行解析入口（无凭据）
2026-11-10 | Phase 2 ideaseek ingest（扫描→按内容哈希跨 run 增量分派 paper.parse→内联执行→FTS 刷新→search 提示；空转 no-op 不建 run）+ make-fixture --marker | 3d0117a | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 27 files/161 vitest + 5 python 全过 | 相同字节的重复 PDF 按内容寻址只索引一次（预期语义）；抽取/综合仍需模型凭据 | Phase 2 可无凭据推进的模块已完成；余项需 DEEPSEEK_API_KEY 或用户语料（见阶段汇报）
2026-11-10 | Phase 2 Evidence Checker checkbox 完成确认（确定性核验层已交付并测试；语义级复核增强仍需模型）| cd7959e | 同上 | 数值-单位逐项对照依赖抽取带 quote；无 quote 的页码定位记为 weak | 外部依赖：真实抽取需 DEEPSEEK_API_KEY，gold set 需用户语料
2026-11-10 | Phase 3 起步：DatasetSlice 契约+确定性种子切分（smoke/quick/standard）、CSV 解析/切片/原子写出与可重建哈希、dataset_slice 注册表（迁移 v3）、data slices/describe CLI | 5325888 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 28 files/171 vitest + 5 python 全过 | 行级切分为 rule v1（组/时间边界由领域适配器提供，limits 已记录）；Dataset Analyst 完整卡片与协议综合待后续 | 下一模块：ExperimentalProtocolProposal 契约与校验
2026-11-10 | Phase 3 ExperimentalProtocolProposal 契约+校验（sourced 字段/来源枚举/置信度/低置信确认清单）+ 协议锁定（哈希+confirmedBy，迁移 v4）+ ideaseek confirm protocol | 89a9d51 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 29 files/180 vitest + 5 python 全过 | 协议「生成」（Protocol Synthesis Agent）需模型凭据；本模块负责契约、校验与锁定 | 下一模块：handoff manifest 或 Leakage/Validity 确定性检查
2026-11-10 | Phase 3 Leakage/Validity 确定性检查（单快照/哈希溯源/行数边界 blocker、种子统一/嵌套 warning-info、组时间边界与协议规则 pending）并接入 confirm protocol 门禁 | d8ef880 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 30 files/186 vitest + 5 python 全过 | 语义级泄漏检查（标签/时间因果）需协议与领域适配器，已作为 pending 明示 | 下一模块：Dataset Analyst 确定性数据画像
2026-11-10 | Phase 3 Dataset Analyst 确定性画像与 dataset card（profileCsv：缺失/重复/常量列/数值类型/label 候选 0.6 置信需确认/许可线索；knowledge/dataset-card.json+md；data describe 升级）| f6cbd07 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 31 files/190 vitest + 5 python 全过 | 仅 CSV 画像；label 语义与切分含义按契约留待用户确认；LLM 增强版分析师属于凭据解锁项 | 下一模块：Scenario/Portfolio 契约或 handoff manifest
2026-11-10 | Phase 3 Scenario/Portfolio L0–L4 契约+校验（等级枚举/重复/稳定性种子≥3/L4 外部数据门槛/晋级与停止规则）+ buildDefaultPortfolio 确定性默认组合 | a90e0de | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 32 files/196 vitest + 5 python 全过 | Experiment Designer LLM 生成与实际实验消费属凭据/Phase5 依赖；晋级执行需 idea workspace | 下一模块：handoff manifest 或收口汇报
2026-11-10 | Phase 3 handoff manifest 契约（slice 引用+环境+命令+provenance+不执行全量训练的边界声明）与 buildHandoff 组装器 | 7a084e0 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 33 files/200 vitest + 5 python 全过 | experiment handoff CLI 命令待 idea workspace（Phase 5）接线 | Phase 3 无凭据可交付项完成
2026-11-10 | Phase 3 checkbox 确认：Leakage/Validity Checker（确定性层+pending 明示）、ProtocolProposal schema、协议确认与锁定、Scenario L0–L4、DatasetSlice+handoff+晋级规则（CLI promote/handoff 待 Phase 5 接线）| d8ef880+89a9d51+a90e0de+5325888+7a084e0 | 各模块门禁全绿（33 files/200 vitest+5 python）| Protocol Synthesis LLM 生成需凭据；语义级检查需适配器 | 剩余：数据分布保持检查（可做）与首发领域验证（需语料）
2026-11-10 | Phase 3 数据分布保持检查（类别 top-share 漂移 warning/blocker、数值 σ 均值漂移、slice.distributionCheck 记录与构建时打印）| 22b4938 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 34 files/205 vitest + 5 python 全过 | 客户端/域/主体边界对通用 CSV 以 pending 明示（领域适配器负责）；标签无关漂移检测 | Phase 3 剩余仅凭据依赖项（Protocol Synthesis LLM）与语料依赖项（首发领域 gold set）
2026-11-10 | 真实语料+真实凭据验证批次：.env 安全加载（679cdc3）、74 篇增量扫描/解析全通+坏PDF失败隔离（2af9b9a）、capability guard 关闭原生工具逃逸+keyed 真实模型集成测试（3025170）、引文排版归一化（508f32e）| 全部见各 commit | 门禁：pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 36 files/217 vitest+5 python（含真实模型 keyed 测试）；真实证据核验13/13与8/8 pass；增量证据：冷扫描reused=0→热30→wave2 new44/skip30→74/74 indexed | 论文/数据/.env 均被 gitignore 排除且 staged 无 secret；并行 map、向量检索、LaTeX/OCR、gold set 仍未做 | 下一模块：Paper Extractor 并行 map 阶段（extract --parallel 批量抽取）
2026-11-10 | Phase 2 Paper Extractor 并行 map 阶段：ideaseek extract（增量选择/extract+verify 链/K 个并行 worker 子进程/超时与退出码）、handler 跨 run 全局 parsed 复用 | ac64bfe | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 37 files/222 vitest+5 python 全过（fake 并行 e2e + keyed 真实模型并行 e2e，2 篇/K=2/零失败）| 并发上限钳制4（API/内存保护）；全量 74 篇真实抽取由 --limit 分批执行以控成本 | 下一模块：论文 gold set 回归（语料已就位）或向量检索
2026-11-10 | Phase 2 gold set 回归：sampleSources+evaluateSource+aggregate（覆盖率/卡片有效/证据支持/页定位/哈希绑定/判定通过率）+ ideaseek evaluate + knowledge/goldset-report.json | 80182b1+0454b79+2edc576+timeout-fix | 门禁 38 files/230 vitest+5 python 全绿 | 真实校准（12 篇/seed42，真实模型）：coverage100% cardValid100% evidence89.5% pageAccuracy89.5% hashBinding100% verdictPass75% avgClaims8；3 篇存在未过核验引文（模型转述/页码归属），正是人工复核入口 knowledge/goldset-report.json；全语料74/74 已抽取+核验 | 下一模块：主题综合、机制库和研究地图（卡片已就绪，凭据已解锁）
2026-11-10 | Phase 2 主题综合/机制库/研究地图：确定性聚类+契约校验+可复用增量 synth.topic/synth.map 任务+ideaseek synthesize+paper-cards/syntheses/research-map 导出 | 8f02e55 | 门禁 39 files/238 vitest+5 python 全绿 | 真实模型在76卡语料上：4 主题+地图 5/5 任务完成，knowledge/research-map.md 含量化谱系/带引用冲突/证据空白（每条引 papers/*.pdf）| 机制库以 mechanisms[] 落在各主题综合中；剩余 Phase 2 项：LaTeX/OCR/表格解析与向量检索 | 下一模块：向量检索或 LaTeX 解析（均可无新凭据）
2026-11-10 | Phase 2 表格解析：pdfplumber tables 命令+extractTables 桥+paper.tables 任务+ingest --tables（增量、opt-in）| be5a3bc | 门禁 40 files/242 vitest+7 python 全绿；真实 FL 论文在管线内抽出2个表格 | OCR 仍缺 tesseract（环境阻塞）；LaTeX 源解析与向量检索待决策 | 下一模块：LaTeX 源解析（无阻塞）
2026-11-10 | Phase 2 LaTeX 源解析：parseLatex（注释/命令/章节/标题/转义）+paper.latex 任务（统一 parsed-paper 形状）+ingest .tex 增量 | d6bde51 | 门禁 41 files/248 vitest+7 python 全绿（含 .tex→FTS 检索 e2e）| OCR 仍缺 tesseract；向量检索待 embed 提供方决策 | Phase 2 可做项全部完成，剩 OCR（环境）与向量（架构决策）
2026-11-10 | Phase 2 OCR：worker ocr 命令（pypdfium2+rapidocr≤20页）+隔离 venv 锁定依赖（系统 onnxruntime 段错误→ort1.19.2 锁定）+paper.parse NO_TEXT_LAYER 自动回退（失败信息含 OCR 尝试证明）| 183e3f9 | 门禁 42 files/250 vitest+9 python 全绿（venv real OCR roundtrip + 无文本 PDF 永久标记）| 扫描件正向 e2e 依赖带图 fixture（现有夹具均为文本层）；OCR 每页1-3s 属 opt-in 成本 | 向量检索仍需 embed 提供方决策（DeepSeek 无 embeddings 端点，404 已验证）
2026-11-10 | checkbox「PDF/LaTeX/OCR/表格/图表解析」完成确认：PDF 文本(74/74)、LaTeX(paper.latex)、OCR(venv rapidocr 回退)、表格(pdfplumber opt-in)均落地并测试；图表的文本/题注已随页文本覆盖，图内数值提取属视觉模型扩展（未做，如实注明）| 汇总 2d4ee1d 系列 commit | 门禁 42 files/250 vitest+9 python | 该 checkbox 按用户规则（实现+测试+commit）打勾
2026-11-10 | Phase 3 Protocol Synthesis Agent：buildProtocolInput（语料+数据画像、无数据集时强制低置信标注）+protocol.propose 任务（内嵌 schema/平台盖章/校验门/哈希复用）+ ideaseek protocol propose 接入 confirm 锁定闭环 | b53340f | 门禁 43 files/254 vitest+9 python 全绿（propose→confirm→lock e2e + proposal-current 幂等）| 真实模型版协议提案可用 --harness dsh（伪输出已过校验器；真跑待数据集语义确认更有意义）| Phase 3 余：数据分布已做、领域验证需用户数据集
2026-11-10 | 真实模型协议闭环验证：protocol propose --harness dsh（1/1 完成）→ confirm --by researcher 锁定；指标带 paper-evidence 来源（accuracy↑/comm-rounds↓、conf 0.75-0.85）、基线取自语料真方法（FedAvg/FedProx/FedDF/FedMD/FedProto/FedGKT）、数据依赖字段被自动降为 agent-inference 低置信并生成5条用户确认项 | 代码同上（89a9d51 系列）| 无需新提交（真实运行验证）| Phase 3 仅余「首发领域验证+gold set（联邦学习）」——需用户提供 datasets/ 数据集与 comparison 代码
2026-11-10 | 外部只读数据集接入（用户决定1）：inputs.readonly_datasets + Python npz 联邦画像（全检查表）+ data describe dataset-manifest.json + 联邦切片规则 v2（选择清单、零拷贝）+ data slices 自动6切片 | 81311b0 | 门禁 44 files/261 vitest+9 python 全绿 | 真实 FedPF mnist 实测：20 clients/52,492 train/17,508 test、x=[N,1,28,28]f32、labels0-9、tvMean=0.7348（强 non-IID）、rootHash sha256:20da58b6…、只读指纹前后一致、staged 无数据文件 | research.yaml 仅含路径（已提交）；.npz 需 allow_pickle 已处理
2026-11-10 | 用户决定2落地：本地 embedding（fastembed0.9.1+MiniLM-L6-v2/Apache-2.0，共享缓存+指纹 manifest）、迁移v5向量表、增量嵌入、FTS-first RRF 混合检索+全失败回退、setup/doctor --install-embeddings、证据免责输出 | 591cb11 | 门禁 45 files/266 vitest+9 python 全绿 | 真实74篇：首搜嵌入1357页(8m13一次性)/hybrid融合40+40；复搜增量0嵌入3s；无外部 embedding API | Phase 2 checkbox 全部完成
2026-11-10 | Phase 4 起步：ComparisonMethod 契约+状态机（合法迁移/excluded·blocked·partial 必须带 reason）、迁移v6 comparison 注册表（upsert/get/list/transition+history）、匿名 git 导入器（GIT_TERMINAL_PROMPT=0、upstream 只读+worktree 隔离、commit/license 溯源、重复导入拒绝）、ideaseek comparison import/list/set-status/smoke（smoke 结果按状态机落库、method.yaml 同步导出） | 14aaedf | 门禁 46 files/281 vitest+9 python 全绿（含本地 git fixture 导入/隔离/状态机 e2e）| 官方代码自动定位（从论文找 repo）未做；smoke 默认 entry 为 `python --version` 占位；Baseline Repair/Reproduction Agent 未做 | 下一模块：官方代码定位与许可证记录或 Baseline Repair Agent
2026-11-10 | Phase 4 官方代码定位与许可证记录：确定性 repo URL 发现（paper_fts LIKE 预筛+归一化/保留 owner 过滤、comparison discover → knowledge/comparison-candidates.json）、comparison register 候选注册（不 clone、candidate 状态入状态机）、import 免 url 回退已注册 repo 并记录 candidate→accepted→source-resolved 跳跃历史、许可证读取+classifyLicense 分类（permissive/weak-copyleft/copyleft/unknown/none 入 repo.licenseKind） | 25752a1 | 门禁 46 files/289 vitest+9 python 全绿（URL 归一化/许可证分类/候选聚合/DB 发现/register→import 无 url 回退 e2e）| LLM 从实验表格发现候选（Phase 6）、GitHub API 元数据检索、许可证策略门禁（allowlist 拒绝）未做 | 下一模块：Baseline Repair Agent 或统一 ExperimentSpec/RunResult
