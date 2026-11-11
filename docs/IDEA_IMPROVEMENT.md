# IdeaSeek 已有 Idea 改进工作流

IdeaSeek 不只支持从论文生成全新 idea，也支持用户带着已有 idea、代码和实验结果进入改进流程。目标是找到“临门一脚”问题：效果不足、机制不完整、泛化差、比较不公平、实现瓶颈或新颖性不足，并提出有证据的改进路线。

## 用户输入方式

首选交互与普通项目材料保持一致：用户把已有 idea 文件夹或压缩包放进项目根目录的 `idea-seeds/<idea-name>/`，然后运行 `scan/intake`。`idea-seeds/` 是可为空的用户输入目录，与 `papers/`、`datasets/`、`comparisons/` 同级。压缩包可以包含任意代码仓库结构、idea 描述、配置、日志、指标、已有 checkpoint 和 README；不要求代码目录叫 `src/`、入口叫 `train.py` 或符合 IdeaSeek 自己的模板。用户不需要先解压、重排仓库或执行特殊 import 命令。

```text
research-project/
  idea-seeds/
    hetero-distillation/
      README.md
      idea.md
      code/
      configs/
      results/
```

```bash
ideaseek scan
ideaseek intake
ideaseek idea improve --source idea-seeds/hetero-distillation --question "为什么跨客户端泛化不足？"
```

Intake Agent 递归扫描仓库结构，检查 README、语言/依赖清单、训练与评估入口、配置、测试、数据加载器和 git 元数据，生成 `RepositoryUnderstanding`：候选入口、运行命令、环境、数据接口、指标、路径依据和置信度。随后 Code Analysis Agent 在只读快照中检查源码和调用关系，必要时生成独立 wrapper/adapter。所有自动识别都必须附证据；找不到入口或无法理解数据契约时，展示具体候选并请用户确认。Agent 不得为迎合标准结构而移动或重命名原文件。

如果用户放入多个 idea，`intake` 分别展示仓库入口、配置、结果和歧义；用户选择后才创建正式 Idea 对象。源仓库可以是单层脚本、深层 package、多入口项目、notebook、Makefile 驱动或 monorepo，均按同一“扫描→理解→确认→隔离运行”流程处理。

## 原始版本保护

确认导入后，用户原始目录留在 `idea-seeds/<name>/` 并以只读 snapshot/hash 登记；平台在正式 idea 下建立独立 workspace/branch：

```text
ideas/idea-001/
  source/          # 用户原始代码的只读引用/hash，不复制进可变工作区
  versions/
    v1/             # 导入版本
    v2/             # 工程修复或改进版本
  proposals/        # 改进路线和证据
  experiments/
  handoff/
```

平台不覆盖用户原始代码；所有修改都有 diff、parent version、原因和测试结果。

## 诊断阶段

Idea Improvement Agent 先建立诊断报告：当前方法的机制和假设、与论文和最近 comparison 的差异、当前数据/场景上的错误分布、代码/指标/切分/资源问题、泄漏或不公平风险、工程提升与科学机制提升的区别、新颖性风险，以及最小可区分诊断实验。

诊断区分 `implementation_issue`、`environment_issue`、`data_issue`、`metric_issue`、`comparison_issue`、`hypothesis_issue`、`novelty_issue` 和 `insufficient_evidence`。

## 改进路线

```text
原始 Idea v1
  ├── v2-engineering：修实现/依赖/效率
  ├── v2-mechanism：改机制但保留核心假设
  ├── v2-generalization：针对失败场景增强泛化
  └── idea-002：科学假设改变，创建新 idea 分支
```

每条路线说明论文证据、当前失败依据、预期机制、关键改动、风险、区分性实验、消融和停止条件。科学假设变化不能伪装成普通代码优化。

## 验证与交付

```text
导入原始代码/结果
→ 复现用户 baseline
→ 工程/数据/指标诊断
→ quick 诊断实验
→ 多个改进 proposal
→ 独立代码版本
→ smoke/quick/standard 验证
→ 消融和失败场景
→ Result Analyst
→ supported improvement / inconclusive / rejected / new idea
```

如果用户已有结果无法复现，标记 `baseline_unavailable`，不能直接声称改进有效。报告列出原始 idea、诊断、各改进路线、代码 diff、实验和消融、失败原因、新颖性风险和推荐路线。没有值得继续的改进时，明确说明原因，不强行生成新版本。
