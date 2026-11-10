# 工作流状态机

## 阶段

```text
INIT
  → INPUT_READY
  → CALIBRATING
  → PAPER_ANALYSIS
  → DATA_READY
  → PROTOCOL_PROPOSED
  → PROTOCOL_REVIEW
  → COMPARISON_DISCOVERY
  → COMPARISON_REPRODUCTION
  → BASELINE_VALIDATED
  → IDEA_GENERATION
  → IDEA_SCREENING
  → EXPERIMENTING
  → IDEA_REVIEW
  → COMPLETED
```

任意阶段都可能进入 `PAUSED`、`AUTH_REQUIRED`、`USER_INPUT_REQUIRED`、`NETWORK_BLOCKED`、`QUOTA_EXHAUSTED`、`FAILED_RECOVERABLE` 或 `CANCELED`。恢复时回到最近可执行 checkpoint。

运行策略由输入规模和证据条件自适应选择：`starter` 适用于少量论文/一个数据集/比较材料不完整的探索；`standard` 适用于中等规模语料；`research` 适用于大量论文、多数据集和更高证据要求。策略只改变默认预算、并发、实验层级和报告措辞，不改变证据、审计和安全要求。

模型 token、API 额度、GitHub 限额或 provider 余额耗尽时进入 `QUOTA_EXHAUSTED`，不是科学失败。Supervisor 停止领取新的模型任务，已提交 artifact 和成功结果保持有效；用户补充额度、更新凭据或切换 provider 后执行 `ideaseek doctor`/`ideaseek continue`，从失败/未完成的最小任务继续。已成功缓存的 PaperCard、综合、comparison 和实验结果不重复调用。若请求已发出但响应未提交，只重试该请求并记录可能的重复成本。

## 门槛

- `INPUT_READY`：输入快照、配置、模型连接和资源预检通过。
- `CALIBRATING`：小批论文产生校准报告，用户确认研究范围或无人值守策略允许继续。
- `PAPER_ANALYSIS`：论文卡片 schema 和证据校验通过；失败论文被标记而不是丢失。
- `DATA_READY`：dataset card、数据质量、切分规则和指标方向已确认。
- `PROTOCOL_PROPOSED`：平台根据论文、comparison 代码、数据集和可选插件输出生成 `ExperimentalProtocolProposal`，覆盖字段/样本单位、切分、泄漏检查、baseline 入口、指标、smoke test、资源、消融和支持/否证判据。
- `PROTOCOL_REVIEW`：证据、泄漏、可行性和公平比较检查通过；只有关键科学歧义需要用户确认，协议锁定后才能进入 comparison 运行。
- `COMPARISON_REPRODUCTION`：所有 required comparison 都有来源和实现计划。
- `BASELINE_VALIDATED`：所有 required comparison 有可运行结果并通过合理性检查；官方代码、兼容修复和论文重实现分别标记。
- `IDEA_GENERATION`：每个候选有论文证据、baseline 局限、可检验假设和停止条件。
- `EXPERIMENTING`：代码通过检查、smoke test、资源测量和实验协议校验。
- `COMPLETED`：候选有明确的支持/否证/不确定结论，代码和实验可复现。

在 `starter` 策略下，缺少有效 comparison 不必永久阻塞 idea 探索，但必须运行/报告 sanity baseline、降低结论等级并标记 `baseline_unavailable`；`standard/research` 默认仍要求所有 required comparison 通过门槛。

## Idea 循环

`--ideas N` 是本次 run 允许进入实现/实验的候选上限，不是要求模型无条件生成 N 个 idea。省略时由平台依据候选差异、证据、预算、资源和预计信息增益选择数量，默认先验证 1 个；未进入实验的候选仍作为 IdeaCard 保存，可在后续 run 继续。

Idea 生成必须经过团队式机制审查：

```text
PaperCards → DesignPrinciples/MechanismMap → ProblemTensions
  → independent proposals → structured discussion
  → novelty challenge → discriminating experiments → IdeaCards
```

候选必须回答“为什么会有效”，而不是只列出采用了哪些模块。`IdeaCard` 需要记录机制链、最接近工作、组件必要性、竞争解释和否证条件。若只是已有模块的无理由拼接，状态为 `DRAFT_COMPOSITION`，不能自动进入实验。消融实验要检验机制中的必要环节，不能只作为装饰性表格。

每个 idea 有独立版本：

```text
PROPOSED → IMPLEMENTING → SMOKE_TESTED → RUNNING
  → ANALYZING → {SUPPORTED | NEEDS_REVISION | REJECTED | INVALID_RUN}
```

`NEEDS_REVISION` 可以生成同一 idea 的新版本；科学假设发生变化时创建新 idea，并链接 `parent_idea_id`。不同 idea 的代码和结果不能混合。

## Comparison 状态

```text
CANDIDATE → ACCEPTED → SOURCE_RESOLVED → IMPLEMENTED
  → REPAIRING → SMOKE_TESTED → EVALUATED
  → {VALIDATED | PARTIAL | BLOCKED | EXCLUDED}
```

`EXCLUDED` 必须有用户或配置原因；Agent 不得静默跳过 required 方法。

## Checkpoint

论文以单篇/小批次，协议以输入快照+证据+适配器版本，comparison 以方法+配置+协议版本+数据切分，idea 以版本+实验规格+run 为恢复单元。只有不可变 artifact 提交成功后才把节点标成 succeeded。模型请求发出但结果未保存时可能只重复该请求，必须记录潜在重复成本；不能重跑整个阶段。

## 人工门槛

用户可确认研究范围、数据解释、comparison 清单、实验预算和最终结果。无人值守模式只能跳过交互提示，不能突破硬预算、权限、数据快照和 required comparison 规则。

## 增量输入

每次 run 固定输入快照。新增论文只创建新的 PaperCard/综合依赖；新增或变化的数据集创建新的 dataset snapshot，并只使依赖该 snapshot 的 comparison、idea 和实验节点失效；新增 comparison 只运行该方法的实现与评测。 未变化的节点复用不可变 artifact。报告必须区分新增、复用、失效和待验证对象。



