# IdeaSeek 工作模式

IdeaSeek 的核心是科研探索。它可以提供一个复用 DSH Runtime 的项目 Agent 模式，不创建第二套 Agent Loop，也不关闭科研安全门禁。

## Analysis 模式（材料分析与研究准备）

Analysis 是用户准备研究材料时使用的只读准备模式。它读取研究问题、已有论文、PaperCard、研究地图、数据画像、comparison 和已有 idea，解析论文并形成 `ResearchMaterialAssessment`：告诉用户哪些论文、数据集/场景、comparison、指标、split、标签语义、消融或资源信息还缺，按 `blocking`/`recommended`/`optional` 分类，附来源、许可证/访问条件、置信度、预计成本、放置目录和可复制下一步。

Analysis 可以继续处理本地材料、发现候选数据集/论文/仓库、更新知识 artifact 和重新评估缺口，但不能写科研代码、锁定正式协议、启动实验、改变 comparison 清单或生成未经确认的科学结论。用户补充材料后重新 `scan`/`intake`，它只重做受影响的节点；当材料和协议足够时，用户切到 Research。

## Research 模式（科研执行）

Research 模式负责论文知识、Protocol Synthesis、comparison gate、IdeaCard、quick/standard 实验、消融、Result Analyst、handoff、ResearchRun、checkpoint 和 Decision/Event。它遵守原始输入只读、idea 隔离、实验 scheduler 和协议/指标门禁。

## Agent 模式：当前实现与目标体验

Research/Analysis/Agent 是持久化的会话模式标记，自然语言按模式分流：

- **Research 模式**：`ideaseek ask` 的 supervisor 分类与现有 CLI use-case 执行——只读查询即时回答，高影响请求生成待审批 Decision，绝不静默执行；问候与能力问题由确定性拦截即时回答（不烧模型）。
- **Analysis 模式**：自然语言进入材料评估与研究准备流程；只写知识和缺口 artifact，缺 required 材料时给出阻塞和下一步，不启动正式实验。
- **Agent 模式**：每条自然语言是一次**真实 DSH coding-session turn**（与 `ideaseek agent` 同一 use-case：项目为 cwd、逐回合记审计事件）；TUI 内跨消息自动 `--resume` 续同一 session，无凭据/运行时不可用时诚实失败并给出 `ideaseek doctor` 指引。子进程 stdin 非 TTY，工具审批一律拒绝（安全默认）——需要逐工具批准的回合请在真实终端直接运行 `ideaseek agent`；TUI 内审批透传与跨 TUI 重启的会话延续仍待交付。

两种模式都仍受项目根路径、网络、凭据和容器策略限制；默认禁止修改 `papers/`、`datasets/`、comparison `upstream/`、锁定协议、已提交实验结果和 handoff。修改科研对象必须走 Research Decision/Approval。`PROGRESS.md` 的 Agent mode checkbox 与 conformance tests 完成前，不承诺完整的 Claude Code 式跨回合工具审批体验。

## Full Research / Publication 模式

这是 Research 在 idea 达到 `HANDOFF_READY` 后的显式升级模式。用户批准后，IdeaSeek 可以发现/下载公开数据、运行 full-scale 实验、生成图表、调用 ARIS-style 写作/claim audit/reviewer workflow，并交付论文草稿和完整复现包。下载、全量训练和论文主张都有独立预算、checkpoint 和审批；它不是普通探索的默认行为。

## 切换方式

交互终端：

```text
/mode research
/mode analysis
/mode agent
/mode
Shift+Tab：在 Analysis、Research 和 Agent 模式之间循环（终端支持时）
```

命令行：

```bash
ideaseek interactive --mode research
ideaseek interactive --mode analysis
ideaseek interactive --mode agent
ideaseek mode show
```

切换时 footer 显示醒目的当前模式和 Shift+Tab 提示；切换输出保持两行——模式迁移与审计事件（含事件号），再附新模式的首条权限提示，完整权限摘要用 `/mode` 查看，不创建第二个后台 run。Analysis 不能绕过 Research 的协议、comparison 和实验门禁。

## 产品边界

实现通用 Agent 能力时，直接复用 DSH 的 session/runtime/tool loop；IdeaSeek 只负责项目边界、角色 capability profile、授权、审计和 UI，不复制 DSH 的 CLI、Agent Loop、上下文管理或工具系统。
