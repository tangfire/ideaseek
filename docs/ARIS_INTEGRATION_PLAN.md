# IdeaSeek ARIS 能力吸收与集成计划

ARIS 已经把很多科研工作流沉淀成可组合的 Markdown skills、跨模型 reviewer 和实验桥接流程。IdeaSeek 不重复实现这些方法论，而是在自己的持久化项目、数据、comparison、资源和 checkpoint 平台上提供兼容的 workflow 层。

## 优先吸收的能力

### P0：科研探索工作流

- `idea-discovery` / `idea-creator`：独立提出多个候选、记录假设和差异；
- `novelty-check` / `prior-art-search`：最近邻和反例检查；
- `experiment-plan`：把 idea 变成可执行实验协议；
- `experiment-bridge`：实验代码、配置、结果和下一步之间的桥接；
- `analyze-results` / `experiment-audit`：从结果、日志和失败实验生成结构化分析；
- `ablation-planner`：由机制链生成区分性消融。

### P1：独立评审和质量控制

- `auto-review-loop`：让独立 reviewer 冷启动读取当前 artifact；
- reviewer independence：每轮评审使用新的上下文，不延续上一次的自我辩护；
- `paper-claim-audit` / `citation-audit`：检查 claim、引用和证据；
- `integrity-forensics`：检查实验选择、结果叙述和异常模式。

### P1：研究记忆和可读交付

- `research-wiki`：把项目事实、论文、idea、实验和决定组织成可搜索研究记忆；
- `render-html`：把 Markdown/JSON artifact 渲染成用户更容易阅读的 HTML；
- `monitor-experiment` / `experiment-queue`：长实验监控、队列和等待原因；
- `paper-write` / `rebuttal`：作为 handoff 之后的可选写作 workflow。

## IdeaSeek 与 ARIS 的职责

```text
IdeaSeek Core
  Project/InputSnapshot/Task/Artifact/RunEvent/Checkpoint
  DatasetSlice/Protocol/Comparison/Idea/Experiment/GPU admission

IdeaSeek Workflow Plugins
  ARIS-style skills、reviewer、研究 wiki、实验审计、HTML report

DSH Runtime
  Agent、Session、Tool、Subagent、provider、权限和执行循环
```

ARIS workflow plugin 只能通过 IdeaSeek 的 Application use-case、ArtifactStore、EventBus、ExperimentSpec 和 Decision/Event 读写状态。它不能创建第二个任务数据库、绕过 comparison gate、直接修改原始数据或另起 Agent Runtime。

## 集成方式

优先支持三种形式：

1. **Skill adapter**：把一个 ARIS skill 的输入/输出映射为 IdeaSeek task 和 artifact；
2. **Reviewer adapter**：通过 DSH provider 或外部 reviewer backend 读取指定 artifact，输出结构化 review；
3. **Artifact adapter**：兼容 Markdown、JSON、HTML 和 ARIS 风格的研究文件，但数据库状态仍由 IdeaSeek 管理。

不把 ARIS 的所有 skills 直接复制进核心。每个接入 skill 声明输入 schema、输出 schema、工具权限、网络、模型 route、成本上限、失败语义和许可证。

## 交叉评审原则

IdeaSeek 的 Idea/Result Reviewer 默认使用 fresh context 读取当前 artifact，不能继续同一个生成会话来“自我证明”。review 结果写入独立 Review artifact 和 Decision/Event，低分或关键反例可以阻止 idea 进入实验/交付。

## 许可证和闭源产品

ARIS 仓库为 MIT 许可。IdeaSeek 可以借鉴其公开方法，也可以在遵守 MIT 版权和许可证通知的前提下复用代码。若复制代码或 skill 文件，必须保留原始版权/许可证、记录来源 commit，并在发行包中提供第三方声明；仅参考工作流思想不需要复制实现。

## 集成验收

- 同一 IdeaCard 可通过 IdeaSeek 原生 workflow 和 ARIS-style skill 得到可比较结果；
- reviewer 输出能回到 PaperCard、ExperimentRun、Artifact 和代码 commit；
- reviewer 失败、外部 provider 不可用或额度耗尽不破坏主 ResearchRun；
- skills 不会绕过权限、预算、checkpoint 和 required comparison gate；
- 研究者可以只安装需要的 skills，不因 ARIS 全量依赖增加安装负担。
