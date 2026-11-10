# IdeaSeek

IdeaSeek 是运行在 Linux 服务器上的多 Agent 科研工作流平台。用户提供研究问题、论文语料、数据集和可选的对比方法，平台使用 DSH Agent Runtime 并行阅读论文、建立可追溯知识库、自动发现和复现对比方法、生成多个候选 idea、编写隔离的实验代码、并行完成小规模验证和消融，再根据结果继续优化或停止。

## 用户入口

```bash
mkdir continual-learning
cd continual-learning
ideaseek init
# 小白用户也可以直接使用 start
ideaseek start --question "如何降低持续学习中的灾难性遗忘？"
ideaseek setup
# 可以把论文、代码和数据先随手放入项目目录
ideaseek scan
ideaseek organize
ideaseek intake
# 将论文放入 papers/，数据集放入 datasets/
# 可选：在 comparisons/ 登记论文或放入代码仓库
ideaseek doctor
ideaseek run --question "如何降低持续学习中的灾难性遗忘？"
# 可选：限制本次最多验证 3 个候选 idea
ideaseek run --question "如何降低持续学习中的灾难性遗忘？" --ideas 3
# 默认使用 quick 数据规模；全量实验由用户拿到代码后自行运行
ideaseek run --question "..." --data-scale quick
ideaseek next
ideaseek attach --run <run_id>
ideaseek status --detail
ideaseek report
```

当前目录是项目根目录。平台创建的 `papers/`、`datasets/`、`comparisons/`、`knowledge/`、`ideas/`、`reports/` 和 `.research/` 都属于项目工作区。

IdeaSeek 不默认替用户下载大型数据集。推荐入口是 `papers/`、`datasets/<dataset-id>/`、`comparisons/<method-id>/` 和不确定材料的 `incoming/`。用户可以先按大致类型放入，再运行 `ideaseek scan` 和 `ideaseek intake`；平台识别、去重、分组并生成待确认清单，`ideaseek organize --apply` 只创建索引/软链接/副本，不覆盖原始文件。用户把可用数据放入 `datasets/` 或配置只读挂载路径；平台只做数据盘点、质量检查和可重建的小规模切分。论文、数据集和 comparison 都按哈希增量处理：后续补论文、补数据或补对比方法时，只运行受影响的任务，已有知识卡片和实验结果复用。
IdeaSeek 默认在用户全量数据的只读快照上生成 `smoke`/`quick`/`standard` 派生切片，先快速验证 idea，再按证据晋级；不会因为改一行代码就自动重新跑一天的全量实验。平台最终通过 `ideaseek experiment handoff --idea <id>` 交付用户自行运行全量实验所需的代码、split、环境、配置和命令，原始数据永远不被修改。

如果运行中模型 token、API 余额或 GitHub 限额用完，平台会暂停在可恢复状态。用户充值或更新凭据后执行 `ideaseek doctor` 和 `ideaseek continue`，平台从最近 checkpoint 接着跑，不重复已经完成的论文分析、comparison 验证或实验。

## 开发原则

- DSH 负责 Agent Runtime、插件、工具调用和会话；科研平台负责持久化工作流、论文知识、comparison、idea、实验和 checkpoint。
- Agent 的能力由角色 profile 显式授予；工具、路径、网络和资源权限最小化。
- 所有重要事实、代码、实验和报告都必须可追溯到输入哈希、版本、运行 ID 和证据。
- 原始论文、数据和上游 comparison 仓库保持只读；自动修改发生在工作副本或 idea 专属目录。
- 所有 required comparison 有效运行前，不进入 idea 实验阶段，除非用户显式改变策略。
- 实验协议不是要求用户预先手工填写；平台从论文、comparison 代码和数据中提出协议草案，检查后只让用户确认无法安全推断的科学语义。
- Idea 不是机械拼接论文模块；平台必须从设计原则、机制、失败边界和问题矛盾出发，经过独立提案、团队讨论、反方挑战和区分性消融。
- 失败、暂停和重启从最小未完成 checkpoint 恢复。

## 文档导航

- [plan.md](plan.md)：完整产品和架构计划、风险、里程碑与取舍。
- [ARCHITECTURE.md](ARCHITECTURE.md)：组件、进程和 DSH 边界。
- [AGENT_ROLES.md](AGENT_ROLES.md)：Agent 角色、能力 profile、输入输出和权限。
- [WORKFLOW_SPEC.md](WORKFLOW_SPEC.md)：工作流状态机、阶段门槛和恢复语义。
- [CLI_SPEC.md](CLI_SPEC.md)：命令、实时交互、后台运行和退出码。
- [TERMINAL_UX.md](TERMINAL_UX.md)：CLI banner、Logo、交互提示符、事件流和审批界面。
- [DATA_CONTRACTS.md](DATA_CONTRACTS.md)：核心对象、目录和 JSON 契约。
- [CONFIG_SPEC.md](CONFIG_SPEC.md)：`research.yaml`、默认值、资源边界和配置迁移。
- [PROVENANCE_AND_CITATIONS.md](PROVENANCE_AND_CITATIONS.md)：论文证据、引用、实验数值和失效链。
- [RESEARCH_INTEGRITY.md](RESEARCH_INTEGRITY.md)：小规模验证、数据泄漏、选择偏差和结果标签。
- [DOMAIN_ADAPTERS.md](DOMAIN_ADAPTERS.md)：多模态、短视频、图像分割和联邦学习等方向的可选解析器/检查器扩展。
- [USER_EXPERIENCE.md](USER_EXPERIENCE.md)：小规模项目、自动模式和小白用户操作路径。
- [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)：可执行开发阶段、任务依赖和验收标准。
- [PROGRESS.md](PROGRESS.md)：带 checkbox 的实际开发进度和模块交付记录。
- [EXPERIMENT_PORTFOLIO.md](EXPERIMENT_PORTFOLIO.md)：从小规模机制验证到多场景/跨数据验证的实验组合。
- [OPERATIONS.md](OPERATIONS.md)：部署、凭据、隔离、备份和故障处理。
- [EVALUATION.md](EVALUATION.md)：平台质量、回归集和验收指标。
- [DEVELOPMENT.md](DEVELOPMENT.md)：给后续开发 Agent 的实现约束和工作方式。
- [CODE_STYLE.md](CODE_STYLE.md)：TypeScript、Python、测试、命名和可观测性规范。
- [GIT_WORKFLOW.md](GIT_WORKFLOW.md)：分支、commit、模块交付和提交门槛。
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)：版本发布、迁移、回滚和升级验收。
- [BOOTSTRAP_DEVELOPMENT.md](BOOTSTRAP_DEVELOPMENT.md)：从 clone DSH、创建 IdeaSeek 私有仓库到让开发 Agent 开工的步骤。

## 首版边界

首版正式支持 Linux；Windows 通过 WSL2 或 SSH 使用 Linux 执行环境。先用一个具体研究任务族验证通用论文学习、协议综合和实验执行，再按需增加薄领域插件；领域插件不是通用 idea 生成的前置条件。`paper-reimplementation` 必须与官方代码复现严格区分，平台不把小规模验证结果表述为已经证明创新。


