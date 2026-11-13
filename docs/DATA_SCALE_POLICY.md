# IdeaSeek 数据规模与快速验证策略

IdeaSeek 的默认定位是快速科研发现、idea 验证和代码交付，不是自动替用户完成最终大规模 benchmark。用户提供的全量数据集始终只读，平台只把它们作为生成代表性验证切片和 handoff 配置的来源；达到 `HANDOFF_READY` 后，用户可以显式批准 Full Research 模式，由平台单独执行 full-run。

## 四级数据规模

| 级别 | 用途 | 典型内容 | 是否用于最终结论 |
|---|---|---|---|
| `smoke` | 检查代码、数据、指标和资源 | 极少样本/少量 batch/短训练 | 否，仅工程有效性 |
| `quick` | 快速比较多个 idea 和消融 | 代表性小切片、少量种子 | 只能作为初步机制证据 |
| `standard` | 稳定性和场景验证 | 更大切片、多种子/多场景 | 可作为当前数据的阶段性结论 |
| `handoff` | 生成全量实验的配置和命令（用户自跑或平台 full-run 共用） | 全量数据路径、完整 split、资源建议和复现脚本 | 交付配置；执行见下方 Full Research 路线 |

默认策略：代码修改/参数探索使用 `smoke`/`quick`；通过快速门槛后在多个用户数据集上运行 `standard` 小切片；达到 `HANDOFF_READY` 后生成 `handoff` 包。IdeaSeek 根据协议和当前机器资源估算 smoke/quick/standard 的安全并发和资源需求。

**探索管线与 Full Research 的边界（产品路线已定）**：探索管线（run/idea experiment）不提供 full 规模选项，避免被长时间全量任务阻塞——这不是能力上限。小数据探索达到 `HANDOFF_READY`、研究者通过 `ideaseek full approve` 明确批准后，**全量 comparison 与最终 idea 实验由平台在 Full Research 模式内执行**（`ideaseek full run --idea <id> --detach`）：绑定已批准的 plan 与 fairness lock，按 required 清单生成 full 规模 ExperimentSpec，复用同一条 ExperimentRunner/ResearchRun/GPU admission/checkpoint/pause-resume/quota 门禁与审计链路，不新建第二套队列。`handoff` 包同时保留为用户自跑的替代路径；用户自跑结果记 `USER_FULL_RESULT`，平台 full-run 结果按普通 RunResult 落盘并绑定 run/code/data/protocol 哈希。

## 切片原则

切片不是任意取前 N 个样本。Dataset/Scenario Planner 根据论文协议、dataset card 和已启用的可选插件生成 split manifest，尽量保留：

- 标签/类别分布和长尾；
- 主体、用户、视频、患者或客户端分组边界；
- 时间顺序和预测窗口；
- 域、场景、设备或来源分布；
- 缺失值、困难样本和异常样本比例；
- 联邦任务中的客户端数量、客户端大小差异、非 IID 程度和模型容量分布。

每个切片记录选择规则、输入 hash、随机种子、统计摘要、生成代码和适用限制。原始测试/确认集不用于反复调参；如果没有足够数据建立独立确认集，报告证据边界。

## 多数据集快速验证

用户可以提供多个全量数据集，例如 4 个数据集。IdeaSeek 为每个数据集建立独立 snapshot 和小规模切片，优先验证：

- 每个数据集至少一个代表性 quick slice；
- 共享的任务定义、预处理和指标协议；
- 数据集之间的分布、类别、域或客户端差异；
- idea 在不同数据集上的方向是否一致；
- 失败数据集和失败原因，而不是只汇总成功数据集。

资源不足时，平台可以先在所有数据集上跑极小 smoke/quick，再对最有信息量的组合运行 standard。这样 20 篇论文和 4 个数据集也能快速判断 idea 是否跨数据集有初步支持，而不是在一个数据集上反复耗时。

## Handoff 就绪门槛

IdeaSeek 交付全量实验 handoff 前，候选至少需要满足用户配置的就绪门槛：

- L0 工程检查通过，代码、环境、数据入口和指标可复现；
- 在共同协议下相对所有 required comparison 有可解释结果，或明确标记缺少有效对照；
- 关键机制消融符合预期，不能只依赖总指标提升；
- 至少多个随机种子，或在样本极少时使用适用的重复/交叉验证；
- 在用户提供的多个数据集/域/客户端场景上进行 quick 或 standard 验证，失败场景完整保留；
- 资源成本、显存、运行时间和数据预处理在 handoff 配置中可估算；
- 代码、配置、切分、环境和命令能在干净工作区重跑。

这些门槛提高全量实验成功的先验概率，但不能保证全量结果一定有效。全量数据规模可能暴露过拟合、计算瓶颈、分布变化或训练不稳定；handoff 报告必须把这些风险和未覆盖范围列出来。

## 晋级规则

Idea 从 `quick` 晋级前必须通过预先登记的工程和机制门槛，例如代码有效、指标正确、相对 required sanity baseline 有可解释变化、关键消融符合预测。晋级不只看单次最高分，要考虑多种子、多个数据集/场景和资源成本。

晋级到 `standard` 时重新生成或扩展各数据集切片，但保持任务定义、预处理和比较协议一致。`quick` 失败通常淘汰或修改 idea；`quick` 成功不保证 `standard` 或用户 full-scale 实验成功。若晋级失败，Result Analyst 必须说明是规模敏感、分布变化、资源限制还是机制不成立。

handoff 使用分级置信度，而不是二元的“有效/无效”：

```text
EXPLORATORY       仅有 L0/L1 或 comparison 不完整
PROMISING         L1 + 部分 L2，值得继续验证
HANDOFF_READY     达到配置的跨数据/场景、复现和资源门槛
USER_FULL_RESULT  用户自行完成 full-scale 后的结果，不由 IdeaSeek 代替声明
```

## CLI 与配置

```bash
ideaseek run --question "..." --data-scale quick
ideaseek full plan --idea idea-001
ideaseek full fairness --idea idea-001 --confirm
ideaseek full approve --idea idea-001 --confirm
ideaseek full run --idea idea-001 --detach
ideaseek experiment handoff --idea idea-001
```

`research.yaml` 可以设置 `default_data_scale: quick`、每级预算、最大样本/客户端/步数和晋级门槛。`handoff` 生成完整数据集实验的 split、命令、环境和资源建议（用户可自跑）；平台内全量执行走 `ideaseek full run`（需先 `full plan`/`full approve`，见 FULL_RESEARCH_MODE.md）。用户可以查看：

```bash
ideaseek data describe
ideaseek data slices
ideaseek status --detail
```

## 缓存与迭代

预处理、特征、视频 clip、token、图像 resize、客户端分片和 baseline 初始化结果按数据/代码/配置 hash 缓存。只改模型代码时不重做不受影响的预处理；只改 idea 时不重跑论文和 comparison。缓存失效必须可解释。
