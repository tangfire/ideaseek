# ARIS 与 IdeaSeek 的关系

[Auto-claude-code-research-in-sleep（ARIS）](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep) 是一个 MIT 许可的科研 Agent 工作流/技能集合。它强调 Markdown skills、跨模型执行与独立 reviewer，覆盖论文阅读、idea、实验、review、写作和 rebuttal，并可适配 Claude Code、Codex、DSH 等执行器。

## 是否替代 IdeaSeek

不能简单说 ARIS 直接替代 IdeaSeek；两者层次不同：

| 能力 | ARIS | IdeaSeek |
|---|---|---|
| 论文到 idea/实验的方法论 | 强，已有大量可组合 skills 和 workflow | 核心目标，正在构建结构化流程 |
| 跨模型独立 reviewer/对抗评审 | 重点能力 | 由 Novelty Challenger/Result Analyst 规划，可接 reviewer backend |
| 用户随手输入论文/数据/代码的 manifest | 依赖 skill/Agent 工作区约定 | 核心能力，扫描/intake/哈希/增量 |
| comparison 导入、修复、论文重实现、状态门槛 | 可由 workflow 驱动 | 结构化 ComparisonMethod、gate、upstream/worktree、ExperimentSpec |
| 长任务 DB/checkpoint/租约/多轮 IdeaRound | 主要依赖项目文件和宿主 Agent | 一等对象和持久化工作流 |
| 多 GPU 资源准入和项目预算 | 可通过 skills/工具编排 | Capacity Planner、队列和资源审计 |
| full-scale handoff、数据 snapshot、artifact provenance | 工作流产物 | 结构化 handoff、数据/代码/协议/运行溯源 |
| CLI/TUI | 有成熟 CLI/REPL 方向 | IdeaSeek 专用 CLI/REPL |
| 论文写作、rebuttal、slides | ARIS 覆盖更广 | 当前不是主线 |

如果用户只想“给论文/代码，让 Agent 一晚上研究并写报告”，ARIS 可能可以直接使用。如果要做实验室长期平台，要求项目隔离、任意数据/代码输入、comparison 复现门禁、GPU 调度、checkpoint、增量运行和可审计 handoff，IdeaSeek 仍然有独立价值。

## IdeaSeek 应该借鉴什么

- 跨模型 reviewer 和 fresh-thread independence；
- 论文→idea→experiment→review 的成熟 workflow 编排；
- Markdown 作为人类可读、机器可解析的中间 artifact；
- 论文写作、审稿意见和 rebuttal 可作为未来可选 workflow；
- 把 reviewer/skill backend 做成插件，而不是把所有能力硬编码进核心。

## 不应直接复制什么

- 不把 ARIS 的 Markdown skill 文件当作 IdeaSeek 的任务数据库；
- 不用 skill 运行记录替代 IdeaSeek 的 Task/RunEvent/Artifact/Checkpoint；
- 不绕过 IdeaSeek 的 comparison gate、数据快照、资源准入和证据门禁；
- 不在两个 Agent Runtime 之间复制上下文和生命周期。

## 集成方向

未来可以提供 `aris-compat` 或 reviewer/skill adapter：

```text
IdeaSeek ResearchRun
  → 生成结构化 PaperCard/IdeaCard/ExperimentReport
  → 调用 ARIS 风格的 reviewer/写作 workflow
  → reviewer 输出回到 Decision/Event 和报告 artifact
```

集成应是可选插件；IdeaSeek 的核心状态、数据、实验和恢复语义保持唯一。
