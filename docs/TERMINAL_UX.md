# IdeaSeek 终端交互与 Logo 规范

IdeaSeek 的 CLI 是长期科研工作流的前端，负责显示 Supervisor 的事件和接受控制命令。它不拥有科研状态；状态来自 Workflow DB 和持久化 RunEvent。交互模式应作为独立的终端应用壳运行，而不是在 PowerShell 输出流上不断追加文本。

## 交互模式的终端应用壳

交互模式启动后进入原始 TTY/备用屏幕（终端支持时），由 TUI renderer 维护固定布局：

```text
┌─ header：IdeaSeek / project / mode / model / run ─────────────┐
│                                                               │
│  event/activity pane：Agent、论文、comparison、idea、实验      │
│  可滚动、可折叠、支持事件回放                                  │
│                                                               │
├─ command palette：输入 / 或普通问题时原地过滤                  ┤
│  ideaseek › /model▌                                             │
│  > /models   model tier routes                                 │
│    /mode     switch research/agent                            │
├─ footer：stage / queue / GPU / budget / approval               ┤
└───────────────────────────────────────────────────────────────┘
```

输入编辑区必须始终固定在同一行；命令菜单是覆盖层，不能把输入复制成多行。用户继续输入时只更新候选和高亮，不滚动整个终端。上下键、Tab、Enter、Esc、Ctrl-C 和终端 resize 由 TUI 输入层统一处理。输入行本身有明确的“输入感”：加粗品牌前缀 + 全宽淡色底条（用 U+2800 盲文空白填充到终端右缘——Ink 对每行做 `trimEnd`，普通空格会被裁掉，U+2800 不是 Unicode 空白所以保留），空闲时光标块闪烁（约 530ms），执行命令时同一格原位显示 braille spinner，忙碌状态在输入行直接可见。

输入行有三种互斥状态：**常规编辑**（composer）、**工具审批**（琥珀 `⏸ allow …`，见审批界面）、**密钥捕获**（`🔐 API key (input hidden): •••`——字符只存在于渲染组件的本地缓冲，Enter 提交、Esc/Ctrl-C 取消、Backspace 删除，**绝不回显、绝不进转录、绝不走 argv**）。`/models setup` 走该状态：捕获后以 `models setup --api-key-stdin --test` 拉起子进程（默认先连接测试，失败零写入），行式 `--plain` 路径无法掩码 → 提示改用真实终端运行 `ideaseek models setup`。

TUI 的顶部状态区保持最多两行：项目 · Research/Agent 会话模式 · run 状态（阻塞时附原因），以及当前研究问题；阶段、任务、论文、资源等完整细节一律由 `/status` 提供，不在启动时铺开。block 字标是活动区首部的一次性问候，随事件滚动离开，不永久占据固定行。底部固定显示高对比度的当前模式徽标和 `Shift+Tab` 切换提示。输入 `/` 时，命令面板同时显示命令名与简短用途，选择态清晰突出；活动区把命令输出按逻辑行呈现并移除内嵌 ANSI 控制码，防止外部 CLI 输出破坏 Ink 重绘。

交互模式可以使用成熟的 TypeScript TUI/terminal renderer，但必须保留 IdeaSeek 的事件、权限和 use-case 边界。不要继续在 readline 上堆叠更多光标逃逸来模拟全屏应用。

## 实现状态：Ink 已接入真实 interactive（2026-11-12）

按复用优先门禁，交互壳选用 **Ink**（`ink@6.8.0` + `react@19.1.10`，MIT；选型对比见 ADR-010），不再手写光标/清屏/输入重绘。`src/cli/shell/app.tsx` 是**真实交互 TTY 的唯一 interactive renderer**：按键经纯 `ShellEngine`，命令经共享 `InteractiveSession`（`src/cli/shell/session.ts`）——与经典行式路径、非交互 CLI 完全同一批 use-case（slash 转发、自然语言 `ask`、审批块与 `/approve`、`/open` 两步切换、事件回放 + 实时 `attach --json` 流、会话开始/结束标记）。`/quit` 与 Ctrl-D 只杀事件流子进程并写干净结束标记，绝不取消后台 run。渲染路由（`interactiveRenderer` 单测钉住）：真实 TTY → Ink；`--plain`/`--json`/非 TTY/`IDEASEEK_FORCE_TTY=1` → 行式；`IDEASEEK_FORCE_INK=1` 是管道上跑 Ink 的测试/驱动钩子。Spike 验证（`scripts/spike-drive.mjs` 跨进程驱动 + `tests/shell-spike.test.ts`）：

- 备用屏幕进出（`[?1049h/l`）、固定 header / activity pane / 输入行 / footer；
- 输入内容始终可见（光标块 `▏` 跟随编辑），`/` palette 原地过滤（不滚屏、不重复 prompt）、↑/↓ 选择、Tab 唯一前缀补全、Esc 关闭、Enter 执行、Ctrl-C 提示、Ctrl-D / `/quit` 退出；
- 后台事件持续刷新（activity pane 尾随跟随 + PageUp/PageDown 翻页）与 resize 重排；
- 平台：Windows 直连、Windows PowerShell 宿主、WSL2 Linux Node 三路 `spike-drive` 全 PASS（跨 drvfs 首次 ink 导入可达 ~22s，驱动以 `SPIKE_MOUNT_MS` 容忍）；
- plain / json / 非 TTY / `IDEASEEK_FORCE_TTY` 管道路径不进入 Ink（`interactiveRenderer` 路由单测钉住），旧 readline 行式路径只服务这些场景。

验证入口：`pnpm exec vitest run tests/ink-interactive.test.ts`（构建产物级：布局、palette、真实 dispatch、Ctrl-C/Ctrl-D、`/quit`、会话标记）· `tests/shell-spike.test.ts` + `tests/repl-ux.test.ts` + `tests/interactive.test.ts`（引擎/驱动/行式回归）· `pnpm shell:spike`（真终端手测）· `node scripts/spike-drive.mjs`（自动化驱动）。

已知限制：Ink 在管道上按屏幕模型做增量行改写，原始字节流会残留旧行内容，跨多帧的整句断言不稳定（测试把易碎断言放在新 pane 首行）；真实控制台 PTY 级验证仍无法在本环境分配。

## Logo

默认启动 banner 使用厚重、立体感的 block ASCII 字标。它直接突出 IdeaSeek 名称，适合交互式终端启动；不在每条事件中重复显示。字标本身就是全部问候语——tagline 只保留在短标识里，宽屏启动不再重复品牌名。Ink TUI 中字标位于活动区首部，随首批事件滚动离开；窄终端或 `--plain` 模式使用短标识。

```text
██╗    ██████╗     ███████╗     █████╗     ███████╗    ███████╗    ███████╗    ██╗  ██╗
██║    ██╔══██╗    ██╔════╝    ██╔══██╗    ██╔════╝    ██╔════╝    ██╔════╝    ██║ ██╔╝
██║    ██║  ██║    █████╗      ███████║    ███████╗    █████╗      █████╗      █████╔╝
██║    ██║  ██║    ██╔══╝      ██╔══██║    ╚════██║    ██╔══╝      ██╔══╝      ██╔═██╗
██║    ██████╔╝    ███████╗    ██║  ██║    ███████║    ███████╗    ███████╗    ██║  ██╗
╚═╝    ╚═════╝     ╚══════╝    ╚═╝  ╚═╝    ╚══════╝    ╚══════╝    ╚══════╝    ╚═╝  ╚═╝
```

窄终端、`--plain` 或不支持 Unicode 的环境使用：

```text
[IS]  IdeaSeek  ·  research from evidence
```

颜色是增强项，不得影响纯文本和 JSON 输出：IdeaSeek 字标使用亮白或青色，idea 使用黄色，检索/Agent 使用青色，成功使用绿色，阻塞/等待使用黄色，错误使用红色。启动时如果终端宽度不足，自动使用短标识，不强行换行。

## 启动信息

交互启动保持克制：固定区最多两行——项目 · 会话模式 · run 状态（阻塞时附原因并用警示色），以及当前研究问题。阶段、任务、论文、资源、supervisor 等完整细节一律由 `/status` 提供，不在启动时铺开。上一会话状态（`last session: …`）与待审批块仅在存在时追加。

```text
fl-model-heterogeneity · RESEARCH · run-20261110-001 · RUNNING
heterogeneous models in federated learning

ideaseek ›
```

无 run 时第一行以 `no run` 结尾。启动时只启动 `status` 一个子进程（不再探测论文计数与 GPU 环境），让首帧尽快出现。启动信息不能显示 secret、完整 prompt 或模型隐藏推理。

## 交互命令

交互提示符支持：

```text
/status       当前阶段、任务、资源和预算
/models       查看和配置模型 route/provider
/mode         查看/切换 Research 和 Agent 模式
/next         下一步和阻塞解释
/papers       论文进度和失败解析
/comparisons  comparison 状态、来源和阻塞
/ideas        idea 状态、版本和实验层级
/experiments  实验队列、GPU 和结果
/logs <id>    查看脱敏任务日志
/approve      确认当前协议/候选/实验门槛
/reject       拒绝并记录原因
/pause        安全暂停
/resume       恢复
/report       生成中间报告
/projects     查看已注册项目
/open <path>  切换当前交互会话的项目
/cleanup      预览可清理缓存
/init         在当前目录初始化项目（空目录里的首条命令）
/help         查看命令
/quit         退出交互界面，不取消后台 run
```

每个斜杠命令都有等价的非交互 CLI 命令，方便脚本和 SSH 使用。

提示符也接受自然语言，例如“为什么 method-b 还没通过？”或“优先验证 idea-002”。自然语言按会话模式分流：Research 模式走 `ideaseek ask`（supervisor 分类为查询、建议或待审批 Decision；问候/能力问题确定性即时应答）；Agent 模式直接作为一次真实 DSH coding-session turn 执行（同一 `ideaseek agent` use-case，TUI 内自动续会话）。高影响操作必须显示摘要并确认。

交互提示符始终显示当前项目名和路径。切换项目后要求二次确认，避免用户把控制命令发到错误的研究目录。

## 实时事件

终端展示可审计的外部动作摘要：

```text
[13:21:04] PAPER_ANALYSIS  PaperExtractor   paper=018  completed  18/42
[13:21:18] EVIDENCE_CHECK  EvidenceChecker  paper=018  verified   12 claims
[13:22:07] BASELINE_REPAIR method=method-b   task=t-104   retry  ModuleNotFoundError
[13:24:32] GPU_QUEUE       idea=idea-001       waiting     1 GPU · 8 GiB
```

终端摘要有长度上限；完整日志写入任务 artifact 并脱敏。客户端断开后事件仍持久化，`attach` 按序号回放后继续订阅实时事件。

备用屏幕没有终端原生回滚，因此 TUI 开启鼠标上报（1000+1006）接管滚轮：上滑按 6 行/格回看历史，PgUp/PgDn 仍可整页翻动；滚动时视图锚定（新到达的事件不会把正在读的内容推走），下滑到底恢复实时跟随，滚到顶自动钳制不越界。点击/拖拽上报被吞掉，绝不落进输入行。代价是终端原生拖选被接管（多数终端 Shift+拖拽仍可选中复制）。

**架构评估（2026-11-14，对照 Claude Code 源码快照的 `VirtualMessageList`/`ScrollKeybindingHandler`/自研 Ink fork）**：CC 的 transcript 同样是**应用自管的虚拟化滚动**（ScrollBox + scrollTop + 高度缓存 + 滚轮/键位绑定），并不依赖终端原生 scrollback——"放弃备用屏幕改追加式渲染"的重写方案**评估后不做**。本 TUI 的分片窗口渲染（每帧只切一屏）在复杂度上等价于其虚拟列表的性能目标（O(可见行)），滚轮/锚定/钳制已对齐；CC 有而我们没有的属后续打磨项：transcript 内搜索（n/N 跳转）、滚动时收起 header 换取行数（sticky chrome）、点击消息展开详情。

活动区 transcript 有三类可区分的行：**用户输入**以 `❯ ` 前缀回显（青色加粗——输入行提交后即清空，不回显就只剩响应，用户无法对照自己问了什么）；**响应**为普通行，紧跟在 `❯` 行之后；**事件**带 `[HH:MM:SS]` 时间戳与阶段标签。错误行红色。行式 `--plain` 路径由 readline 原生回显输入，无需此机制。

命令输出按行**流式**进入活动区：子进程每产生一行立即显示，长任务（extract/report/agent 回合的 DSH 进度日志）的进度不再等到退出才整体出现。Research 模式的自然语言进入 supervisor 前先打一行 `supervisor (<harness>): classifying…`——真模型分类的几十秒不再是死寂的 spinner。运行中按 `Ctrl-C` 立即中止当前命令（整棵子进程树 kill，活动区回一行 `interrupted — the running command was stopped`）；空闲时 `Ctrl-C` 仍只提示 `/quit`。

agent 回合内的**步骤级行**实时进入活动区：`⚙ <tool> <参数摘要>`（模型请求工具，参数压成单行截断）、`⚙ ✓ <tool>` / `⚙ ✗ <tool> — <错误>`（执行结果，经 callId 与请求配对）、回合结束一行 `usage: N in / M out tokens`（科研成本可见）。这些行由 `session.run` 的 `onNotification` 观察 `tool/call`/`tool/result` 事件渲染——**仅回合内展示**；持久化进 RunEvent 流（attach 回放、`ideaseek events`）仍是已登记的步骤级缺口。

### 实现状态：事件粒度为任务级（2026-11-13）

当前实时流覆盖任务/阶段级事件（task/run 生命周期、Decision、artifact 提交与各领域事件），TUI activity pane、`attach`/`watch`/`events` 均按此粒度展示。**步骤级**（单次模型调用内的工具调用与训练 step/epoch 心跳）尚未进 RunEvent 流：`HarnessEvent.tool_call` 已定义但 DSH/fake adapter 只发 `started`/`completed`，`onEvent` 摘要仅进任务日志；`harness_tool_call` 事件目前仅 paper.extract 在任务完成后批量落盘；实验进度心跳写 `progress-<specId>.json` 由 `ideaseek monitor` 快照展示。该缺口登记于 `PROGRESS.md` Phase 1.5 未勾选项与 `PRODUCT_GAPS_AUDIT.md` 缺口 9。会话级 UI 决策（如 Research/Agent 切换的 `change-session-mode` 审计事件）入 DB 供 `ideaseek events` 查询，但不进 TUI 事件流——切换确认行已即时显示该动作，回放它们只会用同款 DECISION 行淹没首屏。

## 审批界面

需要用户决定时使用清晰的确认块：

```text
┌─ Confirmation required ──────────────────────────┐
│ Cannot determine the client unit from the dataset. │
│ [1] user  [2] device  [3] organization             │
│ Type a number, /details, or /reject <reason>       │
└────────────────────────────────────────────────────┘
```

批准动作写入 Decision/Event，并绑定协议、输入 snapshot 和 run。

agent 回合的**工具审批**走 stdio 通道（子进程 env `IDEASEEK_AGENT_APPROVAL=stdio`）：子进程在 stdout 发一行 `__ideaseek_approval__{json}` 请求并阻塞在 stdin 应答上；TUI 把输入行整体切换为琥珀色提示 `⏸ allow <tool>? y allow once · n/Enter reject — <reason>`（此时不可输入其他内容），y/n 应答回传，footer 同步从 `running…` 切到 `waiting for approval…`（状态不说谎），活动区留下 `⏸ approval required` 与 `→ approval allowed once|rejected` 两行审计痕迹。行式路径用裸 `y`/`n` 行应答——应答**绕过命令队列**（回合正阻塞在应答上，入队即死锁）。未 opt-in 的普通管道脚本仍默认拒绝（never auto-approve）；TTY 下仍走原生 y/N 问询。

## 三种显示模式

- **Interactive**：默认，备用屏幕/TUI、banner、固定输入区、事件流和审批；
- **Plain**：`--plain`，无颜色、动画和 Unicode，适合日志；
- **JSON**：`--json`，输出 RunEvent/状态对象，适合自动化和监控。

Logo 和 UI 不能成为后台任务或机器可读输出的依赖。TUI 先做稳定事件显示，再逐步增加进度条、任务树和 GPU 面板。
