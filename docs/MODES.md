# IdeaSeek 工作模式

IdeaSeek 的核心是科研探索。它可以提供一个复用 DSH Runtime 的项目 Agent 模式，不创建第二套 Agent Loop，也不关闭科研安全门禁。

## 三种模式如何协同

Analysis、Research 和 Agent 不是三套互相独立的产品，也不各自创建 PaperCard、研究地图、DatasetCard、comparison 或任务数据库。它们共享同一个项目的输入 manifest、内容 hash、知识 artifact、IdeaSeek workflow DB、RunEvent 和 checkpoint；区别只在于入口、可用工具和允许的写操作。

- Research 已经生成的 PaperCard、证据索引、研究地图、机制库、DatasetCard、comparison 摘要和实验 artifact，Analysis 必须按内容 hash、parser/schema 版本和输入 snapshot 复用，不得重新解析或生成重复版本。
- Analysis 新增论文、数据画像、候选 comparison 或材料缺口评估后，Research 直接读取这些 artifact；只有输入 hash、解析器/schema、模型路由或研究问题变化时，依赖图上的下游节点才失效。
- Agent 修改项目代码、配置或测试后，只使依赖该代码/配置的 comparison、idea check、experiment plan 或 run 失效；原始论文、数据、PaperCard 和已提交实验结果保持可读。
- 模式切换只改变会话权限和任务入口，不重置项目上下文、不创建第二个后台 run，也不复制已有知识。
- 同一个输入在三个模式下都使用同一份 provenance/hash 和 artifact 引用；用户可以从任一模式查看来源、状态、缺口和下一步。

模式切换是一个增量协作流程：通常先 Analysis 判断材料是否够，再 Research 做科研执行；中途可回 Analysis 补材料，再回 Research 继续；需要修代码或环境时切 Agent，修复后由受影响节点重新检查。

## Analysis 模式（材料分析与研究准备）

Analysis 是用户准备研究材料时使用的只读准备模式。它不是只问模型“还缺什么”，而是先把已有材料加工成可推理的研究中间层：

1. 扫描和解析论文、图表、LaTeX 与附件，生成 `PaperCard`、证据定位、全文/混合检索索引；
2. 对 PaperCard 做主题综合、研究地图、方法谱系、机制库和证据冲突整理；
3. 读取用户数据并生成 `DatasetCard`、字段/样本单位、标签候选、分布、缺失/重复/异常和可用场景画像；
4. 整理已有 comparison、代码入口、许可证、环境和可复现性状态；
5. 在这些结构化结果之上生成 `ResearchMaterialAssessment`：告诉用户哪些论文、数据集/场景、comparison、指标、split、标签语义、消融或资源信息还缺。

Analysis 可以继续处理本地材料、发现候选数据集/论文/仓库、更新知识 artifact 和重新评估缺口，也可以生成尚未锁定的切片/协议建议，但不能写科研代码、锁定正式协议、启动实验、改变 comparison 清单或生成未经确认的科学结论。用户补充材料后重新 `scan`/`intake`，它只重做受影响的节点；当材料和协议足够时，用户切到 Research。

## Research 模式（科研执行）

Research 模式负责论文知识、Protocol Synthesis、comparison gate、IdeaCard、quick/standard 实验、消融、Result Analyst、handoff、ResearchRun、checkpoint 和 Decision/Event。它遵守原始输入只读、idea 隔离、实验 scheduler 和协议/指标门禁。

## Agent 模式：当前实现与目标体验

Research/Analysis/Agent 是持久化的会话模式标记，自然语言按模式分流：

- **Research 模式**：`ideaseek ask` 的 supervisor 分类与现有 CLI use-case 执行——只读查询即时回答，高影响请求生成待审批 Decision，绝不静默执行；问候与能力问题由确定性拦截即时回答（不烧模型）。
- **Analysis 模式**：自然语言进入材料评估与研究准备流程；只写知识和缺口 artifact，缺 required 材料时给出阻塞和下一步，不启动正式实验。
- **Agent 模式**：每条自然语言是一次**真实 DSH coding-session turn**（与 `ideaseek agent` 同一 use-case：项目为 cwd、逐回合记审计事件）；TUI 内跨消息自动 `--resume` 续同一 session，无凭据/运行时不可用时诚实失败并给出 `ideaseek doctor` 指引。**TUI 内工具审批已透传**（输入行切换为 `y allow once · n reject` 提示，应答回传子进程；行式路径用裸 y/n 行，见 TERMINAL_UX 审批界面）；未 opt-in 的普通管道脚本仍默认拒绝（never auto-approve），TTY 下仍走原生问询。跨 TUI 重启的会话延续仍待交付。

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
