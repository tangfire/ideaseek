# IdeaSeek 模型分层与路由

IdeaSeek 不要求所有 Agent 使用同一个模型。模型选择是按角色、任务风险、上下文长度、工具需求、延迟和预算动态决定的；模型路由由 DSH provider/profile 管理，Agent 不能自行读取或修改 API key。

## 模型层级

### `fast`

用于低风险、高吞吐任务：

- 单篇论文结构化提取；
- OCR 后文本清理和字段归一化；
- 关键词/摘要分类；
- 简单 PaperCard schema 修复；
- 事件摘要和用户界面解释。

### `balanced`

用于需要一定推理但规模较大的任务：

- 主题综合；
- comparison 候选归并；
- 数据集画像解释；
- 实验协议初稿；
- 代码错误诊断和普通修复；
- 结果日志归纳。

### `deep`

用于高影响、低频率任务：

- 机制库和研究地图综合；
- Idea Generator；
- Mechanism Analyst；
- Novelty Challenger；
- 反方论证和最近邻判断；
- 复杂 Baseline Reproduction；
- 实验结果和下一轮科学假设分析。

### `deterministic`

不调用模型：

- 文件扫描、哈希、去重；
- schema/证据/页码/指标格式校验；
- 任务状态、租约、checkpoint 和资源调度；
- FTS/BM25 检索；
- 数据统计、切片和泄漏规则的确定性部分。

## 默认路由

```yaml
models:
  routes:
    fast: default-fast
    balanced: default-balanced
    deep: default-deep
  roles:
    paper_extractor: fast
    evidence_checker: deterministic
    synthesis_analyst: balanced
    protocol_synthesis: deep
    comparison_discovery: balanced
    baseline_repair: balanced
    baseline_reproduction: deep
    mechanism_analyst: deep
    idea_generator: deep
    novelty_challenger: deep
    experiment_designer: balanced
    code_implementer: balanced
    result_analyst: deep
    workflow_supervisor: deterministic
```

用户可以按 provider/model 覆盖路由，但不能让高成本路由绕过项目预算。一个任务的实际模型、provider、prompt/schema 版本、token、成本和 fallback 都写入 task metadata。

## 用户交互

交互终端中使用：

```text
/models
/models list
/models use fast
/models use deep
/models test --route deep
```

`/models` 显示：

- `fast`、`balanced`、`deep` 当前绑定的 provider/model；
- 是否支持工具调用、结构化输出和长上下文；
- 凭据是否存在（只显示 configured/missing/invalid，不显示 key）；
- 最近连接测试、额度/限速状态和成本累计；
- 当前项目哪些角色使用该 route。

配置 provider 时使用隐藏输入或 DSH credential store：

```text
Provider: deepseek
API key: ********
Save to: DSH credential store
Test connection? [Y/n]
```

模型切换只影响新任务和未开始的步骤；正在运行的任务保留其 run snapshot。切换 provider、model 或 route 会记录 Decision/Event，并让需要新模型能力的下游任务产生明确版本变化。

## 路由规则

- `fast` 失败时可以有限 fallback 到 `balanced`；不能把所有失败无限升级到 `deep`。
- `deep` 任务默认不并行无限复制；按项目预算和信息增益限制次数。
- 需要工具调用、结构化 JSON 或长上下文的任务必须选择支持对应能力的模型。
- 同一 PaperCard/schema 版本的回归集固定模型 route，避免升级后无法比较。
- 模型不可用、额度耗尽或 provider 失败时进入可恢复状态；已成功结果不重做。
- 涉及私有论文/数据时，路由必须遵守外发策略；本地 provider 和远程 provider 不能静默切换。

## 成本与质量报告

报告同时显示各角色的模型层级、总 token、费用估算、平均延迟和 fallback 次数。IdeaSeek 不用更强模型替代证据和实验；`deep` 只能提高推理预算，不能把无证据的主张变成事实。
