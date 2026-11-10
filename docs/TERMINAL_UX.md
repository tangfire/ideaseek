# IdeaSeek 终端交互与 Logo 规范

IdeaSeek 的 CLI 是长期科研工作流的前端，负责显示 Supervisor 的事件和接受控制命令。它不拥有科研状态；状态来自 Workflow DB 和持久化 RunEvent。

## Logo

默认启动 banner 使用厚重、立体感的 block ASCII 字标。它直接突出 IdeaSeek 名称，适合交互式终端启动；不在每条事件中重复显示。窄终端或 `--plain` 模式使用短标识。

```text
██╗██████╗ ███████╗ █████╗ ███████╗███████╗███████╗██╗  ██╗
██║██╔══██╗██╔════╝██╔══██╗██╔════╝██╔════╝██╔════╝██║ ██╔╝
██║██║  ██║█████╗  ███████║█████╗  █████╗  █████╗  █████╔╝
██║██║  ██║██╔══╝  ██╔══██║██╔══╝  ██╔══╝  ██╔══╝  ██╔═██╗
██║██████╔╝███████╗██║  ██║██║     ██║     ███████╗██║  ██╗
╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚═╝  ╚═╝

IdeaSeek · Research from evidence
```

窄终端、`--plain` 或不支持 Unicode 的环境使用：

```text
[IS]  IdeaSeek  ·  research from evidence
```

颜色是增强项，不得影响纯文本和 JSON 输出：IdeaSeek 字标使用亮白或青色，idea 使用黄色，检索/Agent 使用青色，成功使用绿色，阻塞/等待使用黄色，错误使用红色。启动时如果终端宽度不足，自动使用短标识，不强行换行。

## 启动信息

交互启动后显示项目和运行上下文：

```text
[IS] IdeaSeek · Research from evidence
Project : fl-model-heterogeneity
Question: heterogeneous models in federated learning
Mode    : starter
Run     : run-20261110-001
Stage   : PAPER_ANALYSIS
Agents  : 8 active · 2 waiting
Papers  : 42 indexed · 18 new
GPU     : 4 detected · 2 available

ideaseek ›
```

启动信息不能显示 secret、完整 prompt 或模型隐藏推理。

## 交互命令

交互提示符支持：

```text
/status       当前阶段、任务、资源和预算
/models       查看和配置模型 route/provider
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
/help         查看命令
/quit         退出交互界面，不取消后台 run
```

每个斜杠命令都有等价的非交互 CLI 命令，方便脚本和 SSH 使用。

## 实时事件

终端展示可审计的外部动作摘要：

```text
[13:21:04] PAPER_ANALYSIS  PaperExtractor   paper=018  completed  18/42
[13:21:18] EVIDENCE_CHECK  EvidenceChecker  paper=018  verified   12 claims
[13:22:07] BASELINE_REPAIR method=method-b   task=t-104   retry  ModuleNotFoundError
[13:24:32] GPU_QUEUE       idea=idea-001       waiting     1 GPU · 8 GiB
```

终端摘要有长度上限；完整日志写入任务 artifact 并脱敏。客户端断开后事件仍持久化，`attach` 按序号回放后继续订阅实时事件。

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

## 三种显示模式

- **Interactive**：默认，banner、提示符、事件流和审批；
- **Plain**：`--plain`，无颜色、动画和 Unicode，适合日志；
- **JSON**：`--json`，输出 RunEvent/状态对象，适合自动化和监控。

Logo 和 UI 不能成为后台任务或机器可读输出的依赖。TUI 先做稳定事件显示，再逐步增加进度条、任务树和 GPU 面板。
