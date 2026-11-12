# IdeaSeek 架构决策记录

## ADR-001：DSH 只负责 Agent Runtime

IdeaSeek 通过 `HarnessAdapter` 和 DSH 公开 API 使用 Agent、Session、Tool、Subagent 和 provider。科研数据库、长任务状态、GPU 调度和实验产物不放入 DSH session。

## ADR-002：工作流状态独立于 Agent 会话

Project、ResearchRun、Task、Idea、ExperimentRun、Decision、RunEvent 和 Artifact 由 IdeaSeek 持久化。Agent 会话可以重建；成功结果和 checkpoint 不依赖某个进程仍然存活。

## ADR-003：先确定性门禁，再模型推理

哈希、schema、证据定位、数据统计、资源准入、状态迁移和安全检查尽量确定性执行。模型负责抽取、综合、机制和代码建议；模型输出必须通过 schema、证据和策略门禁。

## ADR-004：全量实验交付，不由 IdeaSeek 探索流程执行

IdeaSeek 内部运行 smoke/quick/standard，快速筛选和迭代 idea；通过 handoff 交付用户运行全量实验所需代码、配置、split、环境和风险。

## ADR-005：领域能力是可选插件

通用 Protocol Synthesis 从论文、comparison 代码和数据生成实验协议。领域插件只补充特殊 parser、检查器、指标或 runner，不是 idea 生成的前置条件；插件必须通过公开 SDK 和 capability manifest。

## ADR-006：多界面共享应用用例

交互 REPL、非交互 CLI、JSON 输出和后台控制都调用同一 application use-case，不能各自实现一套状态、门禁或权限逻辑。

## ADR-007：复用优先，重复实现例外

开发任何科研 workflow、Agent 工具或模型能力前，先检查 DSH 原生能力和 ARIS skill/plugin 是否已经满足需求。

- DSH 已提供的 Agent Runtime、Session、Tool、Subagent、provider、上下文和权限不重复实现；
- ARIS 已提供且可接入的 idea discovery、experiment bridge、reviewer、ablation、audit、research wiki、HTML/render 和写作 workflow 不在 IdeaSeek 核心重写；
- IdeaSeek 只实现 ARIS/DSH 没有的持久化项目状态、输入/dataset snapshot、comparison 状态机、资源准入、checkpoint、权限边界、handoff 和适配层；
- 复用通过 adapter/plugin/skill contract 完成，不能复制第二套 Agent Loop 或第二个任务数据库；
- 只有当现有能力不满足可恢复性、安全性、结构化契约或实验公平性时，才实现薄的 IdeaSeek wrapper，并记录原因。

## ADR-008：能力必须，来源可替换

ARIS 的 P0 科研能力是 IdeaSeek 的产品验收要求，而不是用户可选项：idea discovery、experiment bridge、ablation、novelty/independent review 和 experiment audit 都必须存在。优先通过 ARIS skill/plugin 实现；若外部版本、许可证、运行环境或接口不适合，使用兼容 adapter 或等价实现满足相同 capability contract。用户不应因为没有安装某个外部仓库而得到一个缺核心科研质量控制的降级平台，除非运行在明确的 review-only/探索性模式并显示限制。

## ADR-009：成熟能力迁移，不保留重复实现

对 IdeaSeek 已有的 idea、experiment、ablation、review、audit 和研究记忆实现逐项与 ARIS 对比。若 ARIS workflow 更成熟、覆盖更广或质量门禁更强，IdeaSeek 应将该能力的执行 backend 迁移为 ARIS skill/plugin，并保留 IdeaSeek 的 schema、Artifact、RunEvent、Decision、预算和 checkpoint 边界。

- 不为了保留旧代码而维护两套默认实现；
- 旧实现只能作为兼容 fallback，且必须有明确切换策略和回归结果；
- 迁移前冻结契约并写 conformance test，确认失败、取消、恢复和权限语义不退化；
- 迁移后从主流程移除重复入口，避免用户不知道运行了哪套 workflow；
- 仅当 ARIS 无法满足 IdeaSeek 的持久化、安全、资源或结构化契约时，才保留 IdeaSeek 的薄层实现。

迁移完成并通过 conformance/regression tests 后，旧的重复实现、重复 CLI 入口和重复默认配置必须删除；不能以“以后可能 fallback”为理由长期保留两套默认 workflow。删除前保留迁移说明和必要的数据/schema migration，不删除历史 artifact 和 run 记录。

## ADR-010：交互模式是终端应用，不是 readline 输出拼接

IdeaSeek 的交互模式必须提供固定布局、原地输入、command palette、事件 pane、footer、resize 和备用屏幕语义，接近成熟 Agent CLI 的终端应用体验。非交互、plain 和 JSON 模式仍使用行式输出。TUI 只负责展示和输入，不能复制 application/use-case 或维护第二套状态。

框架选型（复用优先门禁，2026-11-12 Spike）：

| 候选 | 结论 | 理由 |
|---|---|---|
| **Ink**（选用） | `ink@6.8.0` + `react@19.1.10`（MIT，vadimdemedes/ink，Node≥20） | React 组件模型的成熟 CLI 框架：声明式渲染 diff 替代手写清屏/光标算术（正是历史 Windows Terminal 漂移 bug 的根因）、`useInput` 原生键盘解码（含 Ctrl/方向/Tab/Esc）、活跃维护、自带 TS 类型、生态最大 |
| blessed / neo-blessed | 否 | 上游停更、fork 陈旧、命令式 API，无组件模型 |
| terminal-kit | 否 | 能力全但生态小、命令式文档模型，接入成本高于 Ink |
| 手写 ANSI（旧实现） | 否（门禁禁止） | 已实测的光标/滚屏/重复 prompt 缺陷来源；只保留为 plain/非 TTY 行式路径 |

依赖记录：`ink@6.8.0`、`react@19.1.10`（运行时），`@types/react@19.3.0`（dev）；许可证 MIT（均在 `pnpm release-check` allowlist）；来源 npm/vadimdemedes/ink；用途 = interactive TTY 单一 renderer；替代方案 = 上表。接入方式 = 薄 `InteractiveShell` adapter（屏幕切换仅 alt-screen 进出两行序列），业务侧只经 `ReplView` 接口调用既有 dispatch/relay/use-case，UI 框架不进入 workflow 状态。
