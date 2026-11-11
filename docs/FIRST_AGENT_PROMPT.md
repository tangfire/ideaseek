# 首个开发 Agent 任务提示

下面的内容可以直接作为开发 Agent 的首条任务消息发送。

```text
你现在负责持续开发 IdeaSeek，工作目录是 D:\\IdeaSeek。

IdeaSeek 是一个基于 DeepSeek Harness（DSH）的多 Agent 科研工作流平台。最终目标是：用户提供研究问题、论文、已有数据和可选 comparison，平台能够并行阅读论文，建立证据知识库，自动生成实验协议，发现/复现/修复 comparison，提出有机制的 idea，分别编写代码，在用户数据的 smoke/quick/standard 小规模切片上并行验证、做消融，并根据结果继续优化或切换思路，最后交付可复现代码和用户自行运行全量实验的 handoff 包。

你要持续推进实现，不要只做分析或给建议。除非遇到真正无法自行解决的外部阻塞，否则不要停下来等待确认。普通的技术选型、文件命名、测试写法和模块拆分请依据仓库文档和常规工程判断直接完成，并在提交说明中记录假设。

开始前必须阅读：
1. AGENTS.md
2. docs/README.md
3. docs/plan.md
4. docs/ARCHITECTURE.md
5. docs/WORKFLOW_SPEC.md
6. docs/DEVELOPMENT.md
7. docs/IMPLEMENTATION_ROADMAP.md
8. docs/PROGRESS.md
9. docs/BOOTSTRAP_DEVELOPMENT.md

按任务补读：
docs/AGENT_ROLES.md
docs/CLI_SPEC.md
docs/DATA_CONTRACTS.md
docs/CONFIG_SPEC.md
docs/DATA_SCALE_POLICY.md
docs/DOMAIN_ADAPTERS.md
docs/EXPERIMENT_PORTFOLIO.md
docs/OPERATIONS.md
docs/EVALUATION.md
docs/CODE_STYLE.md
docs/GIT_WORKFLOW.md

同时检查 D:\\deepseek-harness：阅读它的 AGENTS.md、README、架构文档以及公开的 plugin、bundle、Agent、Session、Tool、Subagent、SDK 接口。不要直接修改 DSH 核心；IdeaSeek 必须通过 HarnessAdapter 和公开 API 接入 DSH，并锁定实际使用的 DSH commit。

## 工作原则

- 每次只推进一个可验证的垂直切片，但完成后自动进入下一个未完成切片。
- 先写/确认数据契约和状态语义，再写实现。
- 每个模块都要覆盖成功、失败、超时、取消、重复提交、租约过期、进程重启和权限拒绝等相关路径。
- 所有长任务必须可恢复；artifact 使用临时文件、hash 校验和原子提交。
- 原始输入、论文、数据和 comparison upstream 只读；修改只能写 worktree、idea workspace 或平台管理的 artifact 目录。
- 不提交 secret、论文、数据、模型权重、实验日志和大文件。
- 不把 DSH session 当作科研工作流数据库；工作流状态必须持久化。
- 不把 paper-reimplementation 当成官方代码，不把 quick 提升写成已证明创新。
- 不把 full-scale 训练放进 IdeaSeek 自动流程；只生成 handoff 配置、命令和复现材料。

## 持续开发顺序

### Phase 0：骨架、状态和恢复

先实现并测试：

- TypeScript 项目骨架和 CLI；
- `ideaseek init`；
- `ideaseek status`、`ideaseek next`；
- Workflow DB 抽象；
- Task 状态、lease、heartbeat、重试、取消和幂等；
- RunEvent 持久化和回放；
- Artifact Store、hash 和原子提交；
- `pause/resume/continue/cancel`；
- 假 Worker；
- 故障注入：Worker 崩溃、输出写入中断、租约过期、重复提交、进程重启。

Phase 0 不接真实模型、GitHub、PDF、GPU 或真实数据。先确保以下流程真实可用：

ideaseek init
→ 创建项目目录
→ 创建 task
→ 假 Worker 执行
→ artifact 提交
→ status/next 显示
→ 进程重启
→ resume 继续

### Phase 1：DSH 集成

实现 HarnessAdapter、固定 DSH commit、最小 Cordis plugin/bundle、一个假 Paper Agent、capability profile、工具 schema、权限和 Agent 事件映射。模型额度耗尽时进入 QUOTA_EXHAUSTED，补充额度后可继续，不重做成功任务。

### Phase 1.5：CLI 交互与可观察性

实现启动 banner、`ideaseek ›` 提示符、RunEvent 实时摘要、审批反馈、attach/watch/replay、plain/JSON 输出和脱敏日志。CLI 只显示 Supervisor 状态，不自行维护科研状态，也不显示模型隐藏推理。

### Phase 2：论文和知识库

实现 input scan/intake/manifest、PDF/PaperCard、证据定位、去重、全文检索、并行 map/reduce、Evidence Checker、主题综合、机制库和研究地图。

### Phase 3：数据和实验协议

实现 Dataset Analyst、Protocol Synthesis Agent、Leakage/Validity Checker、ExperimentalProtocolProposal、协议锁定、smoke/quick/standard DatasetSlice、Scenario Planner 和 handoff manifest。

### Phase 4：Comparison

实现 comparison 发现、官方代码导入、论文重实现、upstream/worktree 隔离、Baseline Repair Agent、统一 ExperimentSpec/RunResult 和 required comparison 门槛。

### Phase 4.5：ARIS P0 科研能力集成

优先复用 ARIS 的 `idea-discovery`、`experiment-bridge`、`ablation-planner`、`novelty-check`、fresh-context reviewer 和 `experiment-audit`。把它们通过 adapter 接入 IdeaSeek 的 artifact、ExperimentSpec、RunEvent、Decision 和 checkpoint；不要重复实现同类 workflow，也不要创建第二套 Agent Loop/任务数据库。完成失败回退、权限、预算和恢复测试后再继续 Phase 5。

同时审计 IdeaSeek 已有的 idea/experiment/ablation/review/audit 实现；如果 ARIS 更成熟，迁移默认执行 backend 到 ARIS，旧实现降级为兼容 fallback 或移除默认入口。迁移前写 capability conformance tests，不能只是并行保留两套默认 workflow。

迁移通过完整 conformance/regression tests 后，直接删除旧的重复实现、旧默认入口和重复配置；不要长期保留两套默认 workflow。保留历史 artifact/run 的读取兼容和一次性 migration 即可。

### Phase 5：Idea 和快速实验

实现 Mechanism Analyst、Idea Generator、Research Discussant、Novelty Challenger、Synthesis Lead、IdeaCard 机制链、DRAFT_COMPOSITION 门槛、独立 idea workspace、Code Implementer、GPU Capacity Planner、quick/standard 实验、消融、结果分析和 idea 迭代。

### Phase 6：领域无关引擎验证与按需插件

用一个具体任务族（可先用联邦学习模型异构）验证通用 Protocol Synthesis、数据切片和实验执行；只有遇到确实需要专用解析器、检查器或安全边界时才增加薄领域插件。再扩展图像分割、短视频、多模态早期预测和联邦学习域泛化。不要把领域插件当作用户手写科研规则，也不要把它作为通用 idea 生成的前置条件。

## 每个模块的完成动作

完成一个模块后必须依次执行：

1. 格式化、类型检查、相关单元测试、集成/smoke test；
2. 运行与该模块相关的失败和恢复测试；
3. 检查 git diff、secret、大文件和无关改动；
4. 更新 docs/PROGRESS.md：只有真实实现、测试和 commit 都完成才能把 `[ ]` 改成 `[x]`；
5. 用 Conventional Commit 提交；
6. 继续处理下一个未完成模块，不要停在“建议下一步”；
7. 每完成一个大阶段，汇报 commit、测试、已知限制和下一阶段，但汇报后继续工作。

## 遇到阻塞时

先自行诊断和修复，包括查文档、检查 DSH 源码、写最小复现、调整实现和补测试。只有以下情况才暂停并清楚说明：

- 需要用户提供无法推断的 GitHub 私有仓库/凭据；
- 需要用户选择科学语义或数据含义；
- DSH 公开 API 与文档冲突且无法安全兼容；
- 环境权限或硬件条件无法通过代码解决。

普通工程决策不要等待用户确认。目标是持续把仓库推进到下一个可验证状态，而不是每完成一个小步骤就停止。
```
