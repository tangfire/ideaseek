# IdeaSeek 架构决策记录

## ADR-001：DSH 只负责 Agent Runtime

IdeaSeek 通过 `HarnessAdapter` 和 DSH 公开 API 使用 Agent、Session、Tool、Subagent 和 provider。科研数据库、长任务状态、GPU 调度和实验产物不放入 DSH session。

## ADR-002：工作流状态独立于 Agent 会话

Project、ResearchRun、Task、Idea、ExperimentRun、Decision、RunEvent 和 Artifact 由 IdeaSeek 持久化。Agent 会话可以重建；成功结果和 checkpoint 不依赖某个进程仍然存活。

## ADR-003：先确定性门禁，再模型推理

哈希、schema、证据定位、数据统计、资源准入、状态迁移和安全检查尽量确定性执行。模型负责抽取、综合、机制和代码建议；模型输出必须通过 schema、证据和策略门禁。

## ADR-004：全量实验交付，不由 IdeaSeek 探索流程执行

IdeaSeek 内部运行 smoke/quick/standard，快速筛选和迭代 idea；通过 handoff 交付用户运行全量实验所需代码、配置、split、环境和风险。

## ADR-005：领域能力是可选插件

通用 Protocol Synthesis 从论文、comparison 代码和数据生成实验协议。领域插件只补充特殊 parser、检查器、指标或 runner，不是 idea 生成的前置条件；插件必须通过公开 SDK 和 capability manifest。

## ADR-006：多界面共享应用用例

交互 REPL、非交互 CLI、JSON 输出和后台控制都调用同一 application use-case，不能各自实现一套状态、门禁或权限逻辑。
