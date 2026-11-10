# IdeaSeek 用户体验与小规模项目模式

## 最短可用路径

小白用户只需要准备一个目录、一个研究问题、若干论文和一个可读数据集：

```bash
mkdir my-study
cd my-study
ideaseek init
# 将论文放入 papers/，数据放入 datasets/；不确定材料放入 incoming/
ideaseek start --question "我的研究问题"
```

`start` 是面向用户的组合命令：自动执行轻量检测、扫描输入、生成缺项清单和小规模运行计划。已有环境变量或 DSH credential 可直接使用；只有模型不可用、数据无法解释或关键权限缺失时才进入向导。高级用户仍可分别调用 `setup/doctor/scan/intake/run`。

## 渐进式确认

第一次只询问最必要的三件事：

1. 研究问题和希望解决的现象；
2. 数据集的样本单位/标签（若平台无法可靠推断）；
3. 是否允许有限外部检索和模型外发。

预算、并发、切分、指标、smoke test 和 comparison 候选由平台先提出合理默认和解释。用户可以接受默认，或运行 `ideaseek next` 查看下一步。高成本实验前显示预算和候选，用户可确认后继续；无人值守配置才跳过这一确认。

## 小规模项目（Starter/Exploratory）

当论文数量较少、只提供一个数据集或没有完整 comparison 时，平台自动进入 `starter`/`exploratory` 运行策略：

- 仍然读取论文、生成 PaperCard、提取机制和形成 IdeaCard；
- 只分析当前语料范围，不声称完成全领域查新；
- 从用户提供/自动发现的 comparison 中尽力验证；若没有有效 comparison，至少建议或运行适合任务的简单 sanity baseline，并明确“缺少有效对照”；
- 在一个数据集上做 L0/L1，并根据资源选择少量 L2/L3 诊断；
- 默认只验证 1 个 idea、限制模型和 GPU 预算、限制最多迭代轮数；
- 输出下一步需要补充的论文、数据、comparison 和场景，而不是阻塞用户获得第一版候选。

Starter 模式的结论标签只能是 `promising_on_available_evidence`、`inconclusive` 或 `blocked`，不能写成普遍有效或已证明创新。用户补充材料后，后续 run 增量升级到更高证据层级。

## 规模自适应

平台根据输入和资源自动选择策略，不以论文数量机械决定 Agent 数量：

| 情况 | 默认策略 |
|---|---|
| 1–20 篇论文、1 个数据集 | starter：完整知识/协议/1 个 idea，少量 L0/L1/L2 |
| 20–200 篇论文、1–2 个数据集 | standard：分簇 map/reduce、多个 comparison、多个 idea |
| 200+ 篇论文或多数据集 | research：分层综合、场景矩阵、跨数据验证和更严格预算 |

阈值可在配置中改，但所有模式都保留证据、失败和未覆盖范围。

## 小白用户能看懂的状态

`ideaseek next` 不显示内部术语作为唯一提示，而显示：当前阶段、已经完成什么、为什么停住、用户要不要做事、下一条可复制命令。例如：

```text
你已经提供：10 篇论文、1 个数据集、没有 comparison 代码
平台已完成：论文初步分析、数据字段识别
当前需要：确认样本单位；平台将自动尝试 1 个简单 sanity baseline
建议命令：ideaseek confirm protocol
预计本轮：1 个 idea，约 2 小时 GPU 上限
```

## 用户成本控制

- 不要求用户先写完整 YAML；`research.yaml` 是高级覆盖项。
- 不要求用户先找到所有 baseline 代码；平台可发现、重实现并标注置信度。
- 不要求用户下载平台建议的数据集；只生成建议。
- 不在没有用户确认时复制/移动原始文件。
- 不让用户理解 Agent 拓扑；用户面对的是阶段、结果和下一步。
- 任何暂停、额度耗尽、权限缺失或输入歧义都可以 `next` 继续获得具体行动建议。
