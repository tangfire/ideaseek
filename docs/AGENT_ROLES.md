# Agent 角色与能力契约

所有角色都是 DSH Agent，但角色拥有不同的模型路由、工具、路径和资源权限。角色之间通过对象 ID 和结构化输出交接，不共享无限增长的对话上下文。

| 角色 | 主要输入 | 主要输出 | 权限边界 |
|---|---|---|---|
| Paper Extractor | 当前 PDF/章节和任务 schema | `PaperCard` | 读原始论文；写知识 artifact；不能任意 shell |
| Workspace Intake | 项目文件树、文件元数据、用户规则 | input manifest、候选分组、待确认项 | 只读扫描；不能移动/删除/覆盖原始文件 |
| Evidence Checker | PaperCard 和证据片段 | 核验结果/纠错任务 | 只读论文和卡片；不能改原文 |
| Synthesis Analyst | PaperCard、检索结果 | 主题综合/研究地图片段 | 写 `knowledge/` 版本 |
| Mechanism Analyst | PaperCard、主题综合、失败边界 | 机制/设计原则/矛盾图谱 | 不能把相关性当因果机制 |
| Protocol Synthesis | 论文实验、comparison 代码、dataset card、领域适配器 | `ExperimentalProtocolProposal` | 必须为每项规则附来源/置信度；不能隐藏假设 |
| Leakage/Validity Checker | 数据探测、协议草案、任务定义 | 泄漏风险、统计/公平性检查 | 发现关键歧义时阻塞正式实验 |
| Comparison Discovery | 研究地图、实验表格、允许的外部元数据 | ComparisonCandidate | 可查询白名单网络；只能写候选区 |
| Baseline Repair | `upstream/`、失败日志、环境规格 | patch、测试结果、状态 | 只写 `worktree/`；不能写上游和系统环境 |
| Baseline Reproduction | 方法论文、统一协议 | 重现代码、假设、置信度 | 只写 comparison worktree；不得冒充官方实现 |
| Experiment Designer | 研究地图、dataset card、基线结果 | ExperimentSpec | 不能直接执行任意命令 |
| Code Implementer | IdeaSpec、公共接口、对比代码只读视图 | idea 代码、配置、测试 | 只能写一个 idea workspace |
| Experiment Agent | ExperimentSpec、代码 commit | ExperimentRun/RunResult | 通过 scheduler 运行容器；无宿主权限 |
| Result Analyst | 日志、指标、Idea 版本 | 结果判断、下一轮建议 | 不能修改原始结果 |
| Novelty Challenger | IdeaCard、研究知识库 | 最近邻、反例、否证意见 | 只读证据；不能自我批准 idea |
| Research Discussant | 独立候选、机制图谱、反方意见 | 结构化支持/反对论证 | 必须引用证据或明确是推测 |
| Synthesis Lead | 各角色候选和讨论记录 | 最终候选集合与取舍理由 | 不能删除竞争解释和失败意见 |
| Workflow Supervisor | 所有状态和策略 | 阶段推进、重试、审批请求 | 不能绕过预算、required comparison 和权限 |

## 工具命名

最小工具集合：`paper_read`、`pdf_extract`、`knowledge_search`、`github_search`、`repo_metadata`、`git_clone`、`git_checkout`、`workspace_edit`、`shell_test`、`container_build`、`experiment_submit`、`run_log_read`、`artifact_publish`、`request_approval`。

## 推理和模型策略

低成本模型用于单篇结构化提取；高推理预算用于跨主题综合、comparison 选择、代码修复诊断、idea 反证和结果解释。无论模型强弱，都必须输出 schema、证据引用和不确定性。Agent 的推理文本不作为用户界面事件；界面显示可审计的动作摘要和结果。

## 失败处理

Agent 输出 schema 错误、证据缺失或工具失败时，Worker 进行有限重试；仍失败则进入人工或阻塞状态。代码错误、环境错误、数据错误、算法假设失败和资源错误必须分开分类。不能把程序崩溃解释成 idea 被否证。


