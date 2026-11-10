# 实施路线

## Phase 0：骨架与可恢复运行

实现 CLI、项目目录、`start` 小白入口、自动环境检测、starter/standard/research 规模策略、宽松输入扫描/manifest、`scan/intake/organize/next/status/pause/resume/attach`、配置抽象、SQLite/PostgreSQL 抽象、RunEvent、Supervisor、任务租约和 artifact 哈希。用假 Worker 和故障注入验证恢复；确认 scan/organize 不移动或覆盖原始文件。

验收：终端断开、Worker 崩溃、进程重启和整机重启后，只重跑最小未完成任务。

## Phase 1：DSH 集成与能力 profile

固定 DSH 版本，建立 HarnessAdapter、Cordis plugins、headless/SDK 启动、模型 provider、角色 profile、工具注册和凭据引用。先让一个 Paper Extractor 完成结构化任务。

验收：不同角色看到不同工具和路径；模型 key 不进入 prompt、事件和日志；Agent session 与工作流状态可关联但互不替代。

## Phase 1.5：CLI 交互与可观察性

实现 IdeaSeek 的交互式终端层：启动 banner、`ideaseek ›` 提示符、阶段/Agent/任务事件摘要、审批界面、attach/watch/replay、pause/resume 反馈、plain/JSON 输出和脱敏日志。UI 只订阅 Supervisor 的 RunEvent，不自行维护科研状态。

验收：用户能看到当前阶段、完成/排队/失败任务、资源和阻塞原因；SSH 断开后可以 attach 继续观察；交互、plain 和 JSON 三种模式都不泄露 secret 或模型隐藏推理。

## Phase 2：论文与知识库

实现 PDF 解析/OCR、页码证据、去重、全文/向量检索、PaperCard、主题综合和研究地图。先用人工标注的 30–100 篇论文校准。

验收：关键字段证据支持率、页码定位、失败文档识别和增量重跑通过 gold set。

## Phase 3：数据集和 comparison

实现 dataset card、Protocol Synthesis Agent、Leakage/Validity Checker、comparison 候选发现、官方代码导入、论文重实现、Baseline Repair 和统一评测协议；不要求先手工完成某个领域的完整适配器。

验收：每个 required comparison 能标记来源、许可、差异和状态；原始仓库不变；至少一个真实任务中所有 required comparison 可运行或明确阻塞。

## Phase 4：Idea 与实验闭环

实现 IdeaCard、独立 idea workspace、Code Implementer、ExperimentSpec、容器执行、GPU Capacity Planner、Scenario Planner、L0–L4 实验组合、基线/候选/消融和 Result Analyst。

验收：两个 idea 能并行运行且互不污染；每个结果能追溯到 idea/version、代码、数据、环境、场景和 run；报告能区分机制支持、稳定性、场景鲁棒性和外部验证；支持继续、否证、无效运行三种路径。

## Phase 5：首个方向验证

选定一个具体任务族（当前可选联邦学习模型异构），用论文、comparison 代码和用户数据自动生成 dataset card、切分、指标、comparison 适配、ExperimentSpec、消融和 gold set。跑通从论文到 baseline、idea、代码、quick/standard 小规模实验和 handoff 的完整闭环。领域插件只补充必要解析器和检查器，不把科学方案硬编码成前置配置。

验收：研究者能检查数据语义、切分和指标；平台能区分代码/环境失败与科学假设失败；结果可复现且不发生明显泄漏。

## Phase 6：可选扩展与产品化

在首个方向闭环通过后，继续扩展从论文实验表格发现 comparison、自动补代码、来源/许可证策略、成本限制和用户确认模式；按真实需求增加薄的多模态、短视频、图像分割或联邦学习解析器/检查器，并扩展多 GPU、本地模型和多数据集场景。

## Phase 7：发布与运维

完成 Linux 安装包、WSL2 使用路径、回归/许可证/secret 检查、备份恢复演练、版本迁移和回滚清单。

每一阶段先写契约和失败测试，再实现 happy path；不要在 Phase 1 前堆复杂多 Agent 角色，也不要在质量指标未达标前追求千篇论文吞吐。


