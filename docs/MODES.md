# IdeaSeek 工作模式

IdeaSeek 的核心仍是科研探索，但可以提供一个复用 DSH Runtime 的通用 Agent 模式。通用模式不是第二套 Agent Loop，也不是把所有科研门禁关闭，而是让用户在同一个项目上下文里处理临时代码、数据和环境任务。

## Research 模式（默认）

Research 模式负责论文知识、Protocol Synthesis、comparison gate、IdeaCard、quick/standard 实验、消融、Result Analyst、handoff、ResearchRun、checkpoint 和 Decision/Event。它遵守原始输入只读、idea 隔离、实验 scheduler 和协议/指标门禁。

## Agent 模式

Agent 模式直接使用 DSH Agent、Session、Tool 和 provider，适合查看/解释项目代码、编写小工具、修复明确的工程问题、运行受限测试、查看日志和准备 handoff 文件。它仍受 capability profile、项目根路径、网络、凭据和容器策略限制。默认不能修改 `papers/`、`datasets/`、comparison `upstream/`、锁定协议、已提交实验结果或已发布 handoff。需要修改科研对象时必须进入明确的 Research Decision/Approval。

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

切换时显示当前模式、权限摘要和影响，不会创建第二个后台 run。Research 与 Agent 模式可以共享只读项目上下文和检索工具，但会话、工具权限和审计事件分开记录。

## 产品边界

先完成 Research 模式的科研闭环，再实现 Agent 模式的最小只读/测试能力。不要为了通用编码功能复制 DSH 的 CLI、Agent Loop、上下文管理或工具系统。
