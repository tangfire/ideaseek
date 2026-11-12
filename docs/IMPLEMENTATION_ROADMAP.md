# 实施路线

## Phase 0：基础运行与可恢复性

实现项目目录、`init/start/setup/doctor`、输入 manifest、配置快照、Workflow DB、Task lease/heartbeat、RunEvent、Artifact Store、Supervisor、pause/resume/continue 和故障恢复。

验收：Worker 崩溃、进程重启、终端断开和整机重启后只重跑最小未完成任务；原始输入不被移动或覆盖。

## Phase 1：DSH Runtime 与 Agent 能力

固定 DSH 版本，建立 HarnessAdapter、Cordis plugin/bundle/profile、provider、capability profile、工具 schema、凭据引用和 Agent 事件映射。

验收：不同角色看到不同工具和路径；模型 key 不进入 prompt、事件或日志；Agent session 与工作流状态互不替代。

## Phase 1.5：CLI 交互与可观察性

实现终端应用壳（备用屏幕/原始输入/固定布局）、command palette、固定输入区、RunEvent 实时摘要、审批反馈、attach/watch/replay、plain/JSON 输出和脱敏日志。不要用 readline+追加 ANSI 文本模拟全屏 UI；CLI 只调用 application use-case，不自行维护科研状态。

验收：用户能看到阶段、Agent、任务、资源和阻塞；SSH 断开后可以 attach；高影响操作有确认；三种输出模式语义一致。

## Phase 2：论文知识与证据

实现 PDF/LaTeX/OCR/表格解析、PaperCard、证据定位、去重、FTS/可选 embedding、增量处理、并行 map/reduce、Evidence Checker、主题综合、机制库和研究地图。

验收：关键字段证据支持率、页码定位、失败文档识别和增量重跑通过 gold set。

## Phase 3：数据画像与实验协议

实现 Dataset Analyst、Protocol Synthesis Agent、Leakage/Validity Checker、ExperimentalProtocolProposal、DatasetSlice、Scenario Planner 和 handoff manifest。领域插件不是前置条件。

验收：协议能从论文、comparison 代码和数据提出并锁定；切片可重建；泄漏门禁和用户确认可解释；原始数据不变。

## Phase 4：Comparison 复现与统一评测

实现 comparison manifest、用户仓库导入、官方代码定位、论文重实现、Baseline Repair、ExperimentSpec/RunResult 和 required comparison gate。

验收：comparison 来源、许可证、patch、环境、复现状态和失败原因可追溯；所有 required 方法通过或明确阻塞。

## Phase 4.5A：ARIS P0 科研质量能力

在 Comparison 契约稳定后，优先接入 ARIS 的成熟科研 workflow：idea discovery、experiment bridge、ablation planner、novelty/prior-art check、fresh-context reviewer 和 experiment audit。通过 skill/plugin adapter 映射到 IdeaSeek 的 IdeaCard、ExperimentSpec、Artifact、RunEvent、Decision 和 checkpoint；不复制第二套 Agent Loop 或任务数据库。

验收：ARIS workflow 能读取 IdeaSeek artifact 并输出结构化结果；失败/额度耗尽/权限拒绝可恢复；comparison gate、预算、证据和实验协议不能被 skill 绕过。

## Phase 4.5B：ARIS P1 研究记忆与长任务增强

接入 research-wiki、HTML artifact renderer、watchdog、experiment queue、monitor-experiment 和 session recovery。它们必须读写 IdeaSeek 的 Artifact/Event/Checkpoint，不创建第二套状态来源。

## Phase 4.5C：ARIS P2 科研完整性审计

接入 paper-claim-audit、citation-crosscheck 和 integrity-forensics，作为 handoff 与 Full Research 的证据门禁。论文写作 workflow 在全量结果生成后执行，不得早于证据冻结。

## Phase 5：Idea 生成与实验闭环

实现 Mechanism Analyst、Idea Generator、Research Discussant、Novelty Challenger、Synthesis Lead、IdeaCard 机制链、独立 idea workspace、Code Implementer、GPU Capacity Planner、quick/standard 实验、消融、Result Analyst、Idea revision 和 handoff。

验收：多个 idea 可并行且互不污染；结果绑定 idea/version、代码、数据、协议、场景和 run；失败实验保留；handoff 门禁正确拒绝不充分结果。

## Phase 6：领域无关引擎验证

用一个真实任务族验证同一套核心引擎可以从论文、comparison 和数据自动生成协议、探索 idea、运行 quick/standard 实验并生成 handoff；再用第二个不同任务族回归，检查没有方向硬编码。领域插件只补充特殊格式或规则。

验收：不同任务族的输入都能进入同一套 PaperCard、Protocol、ExperimentSpec、Result 和 handoff 契约；没有新方向时不需要修改核心 Agent Loop。

## Phase 7：Full Research 与论文交付

对研究者明确认可并通过 handoff 门槛的 idea，先生成带证据的 comparison matrix，明确 required/reference-only/excluded/blocked 和官方代码/论文重实现来源；研究者确认后提供独立、可授权、可恢复的全量闭环：全量运行所有 required comparisons 和最终 idea、统计分析、按真实数据生成多类型图表、结果/claim/citation/integrity 审计，并复用 ARIS `paper-plan → paper-figure → paper-write → paper-compile` 交付 Overleaf 兼容 LaTeX 工程与复现包。目标 venue（包括 CCF A/B）用于规划和质量清单，不能承诺录用。

验收：未经授权不能下载数据或启动全量训练；comparison matrix 有近期工作/venue/任务证据和用户确认；官方代码 clone 与论文重实现清楚区分；required 对比与 idea 使用同一锁定协议/可比资源预算并有可追溯版本；未完成 required 项阻塞运行或需带理由批准 scope 变更；崩溃/额度耗尽/取消后从 checkpoint 恢复；图表和表格绑定结果、统计定义、代码/数据/协议 hash；论文数字都能追溯到 RunResult；Overleaf 工程可编译并包含 BibTeX、图表源数据和 provenance。

## Phase 8：产品硬化与长任务能力

实现 ResearchRun 多轮编排、训练内部 checkpoint、长周期 soak test、自然语言/审批、模型分层路由、多项目上下文、清理/归档/导出、通知、用户反馈和 application/domain/adapter 分层硬化。

验收：用户可从安装、运行、断线、额度耗尽、机器重启、idea 修订到 handoff 完成完整旅程；所有关键操作可解释、可暂停、可恢复。

## Phase 9：发布与文档

完成 README/User Guide/文档站、可选插件 SDK、npm CLI、Linux 安装包、WSL2 路径、依赖/许可证/secret 检查、备份恢复演练、版本迁移和回滚。其他方向和领域插件作为按需 backlog，不阻塞核心发布。

每一阶段先写契约和失败测试，再实现主路径；阶段完成必须更新 `PROGRESS.md` 并提交 commit。
