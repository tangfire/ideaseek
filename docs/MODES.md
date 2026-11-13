# IdeaSeek 工作模式

IdeaSeek 的核心是科研探索。它可以提供一个复用 DSH Runtime 的项目 Agent 模式，不创建第二套 Agent Loop，也不关闭科研安全门禁。

## Research 模式（默认）

Research 模式负责论文知识、Protocol Synthesis、comparison gate、IdeaCard、quick/standard 实验、消融、Result Analyst、handoff、ResearchRun、checkpoint 和 Decision/Event。它遵守原始输入只读、idea 隔离、实验 scheduler 和协议/指标门禁。

## Agent 模式：当前实现与目标体验

当前实现中，Research/Agent 是持久化的会话模式标记；自然语言仍通过 `ideaseek ask` 的 supervisor 分类与现有 CLI use-case 执行。它**还不是**可持续对话的通用编码 Agent，不能承诺拥有 Claude Code 式的仓库浏览、编辑、终端工具调用和多步 Agent loop。

目标体验是直接复用 DSH Agent、Session、Tool、provider 和工具权限，让用户在当前项目里查看/解释代码、编辑项目代码、修复工程问题、运行受限测试和查看日志。Agent 模式仍受项目根路径、网络、凭据和容器策略限制；默认禁止修改 `papers/`、`datasets/`、comparison `upstream/`、锁定协议、已提交实验结果和 handoff。修改科研对象必须走 Research Decision/Approval。此目标需在 `PROGRESS.md` 完成 Agent mode checkbox 和 conformance tests 后才能视为交付。

## Full Research / Publication 模式

这是 Research 在 idea 达到 `HANDOFF_READY` 后的显式升级模式。用户批准后，IdeaSeek 可以发现/下载公开数据、运行 full-scale 实验、生成图表、调用 ARIS-style 写作/claim audit/reviewer workflow，并交付论文草稿和完整复现包。下载、全量训练和论文主张都有独立预算、checkpoint 和审批；它不是普通探索的默认行为。

## 切换方式

交互终端：

```text
/mode research
/mode agent
/mode
Shift+Tab：在 Research 和 Agent 模式之间切换（终端支持时）
```

命令行：

```bash
ideaseek interactive --mode research
ideaseek interactive --mode agent
ideaseek mode show
```

切换时 footer 显示醒目的当前模式和 Shift+Tab 提示，切换后显示权限摘要与审计事件，不创建第二个后台 run。当前 TUI 已有模式状态显示和切换；Agent 能力尚在实现。

## 产品边界

实现通用 Agent 能力时，直接复用 DSH 的 session/runtime/tool loop；IdeaSeek 只负责项目边界、角色 capability profile、授权、审计和 UI，不复制 DSH 的 CLI、Agent Loop、上下文管理或工具系统。
