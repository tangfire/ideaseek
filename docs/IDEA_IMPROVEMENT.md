# IdeaSeek 已有 Idea 改进工作流

IdeaSeek 不只支持从论文生成全新 idea，也支持用户带着已有 idea、代码和实验结果进入改进流程。目标是找到“临门一脚”问题：效果不足、机制不完整、泛化差、比较不公平、实现瓶颈或新颖性不足，并提出有证据的改进路线。

## 输入

用户可以提供研究问题、原始 idea 说明、代码仓库/目录、已有配置/日志/指标，以及论文、数据集和 comparison。

```bash
ideaseek improve --idea ./existing-idea --question "..."
ideaseek improve --idea ./existing-idea --results ./existing-idea/results
ideaseek idea import ./existing-idea
ideaseek idea improve --idea idea-001 --ideas 3
```

## 原始版本保护

用户代码导入为只读 `source` snapshot，平台在独立 workspace/branch 工作：

```text
ideas/idea-001/
  source/          # 用户原始代码，只读、hash 固定
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
