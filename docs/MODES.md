# IdeaSeek 工作模式

IdeaSeek 的核心是科研探索。科研会话有两个权限档位（Research 与 Analysis），另有一个复用 DSH Runtime 的通用 Agent 入口。Agent 入口不创建第二套 Agent Loop，也不在策略上禁止任何写入；科研结论的可信度由「输入变更侦测 + 下游失效」保证，而不是靠拦住 agent 的手。

## 两个权限档位与一个通用入口如何协同

Research 和 Analysis 是同一个科研会话的两个权限档位；Agent 是项目内的通用 DSH 工程入口。它们不是三套互相独立的产品，也不各自创建 PaperCard、研究地图、DatasetCard、comparison 或任务数据库。它们共享同一个项目的输入 manifest、内容 hash、知识 artifact、IdeaSeek workflow DB、RunEvent 和 checkpoint；档位之间的区别在于入口、可用工具和允许的写操作，Agent 与档位的区别在于它不受写面限制、但每次写入都会被审计和侦测。

- Research 已经生成的 PaperCard、证据索引、研究地图、机制库、DatasetCard、comparison 摘要和实验 artifact，Analysis 必须按内容 hash、parser/schema 版本和输入 snapshot 复用，不得重新解析或生成重复版本。
- Analysis 新增论文、数据画像、候选 comparison 或材料缺口评估后，Research 直接读取这些 artifact；只有输入 hash、解析器/schema、模型路由或研究问题变化时，依赖图上的下游节点才失效。
- Agent 修改项目代码、配置或测试后，只使依赖该代码/配置的 comparison、idea check、experiment plan 或 run 失效；原始论文、PaperCard 和已提交实验结果保持可读。它若改动了 `papers/`、`datasets/` 或 `comparisons/upstream/`，不会被拦住，但会话结束后的漂移侦测会把该输入标注 dirty 并要求重新 `scan`，受影响节点随之失效。
- 档位切换只改变会话权限和任务入口，不重置项目上下文、不创建第二个后台 run，也不复制已有知识。
- 同一个输入在两个档位和 agent 会话里都使用同一份 provenance/hash 和 artifact 引用；用户可以从任一处查看来源、状态、缺口和下一步。

档位切换是一个增量协作流程：通常先 Analysis 判断材料是否够，再 Research 做科研执行；中途可回 Analysis 补材料，再回 Research 继续；需要修代码、修数据或修环境时用 `/agent` 起一轮通用 coding 会话，修复后由受影响节点重新检查。

## Analysis 档位（材料分析与研究准备）

Analysis 是用户准备研究材料时使用的只读准备模式。它不是只问模型“还缺什么”，而是先把已有材料加工成可推理的研究中间层：

1. 扫描和解析论文、图表、LaTeX 与附件，生成 `PaperCard`、证据定位、全文/混合检索索引；
2. 对 PaperCard 做主题综合、研究地图、方法谱系、机制库和证据冲突整理；
3. 读取用户数据并生成 `DatasetCard`、字段/样本单位、标签候选、分布、缺失/重复/异常和可用场景画像；
4. 整理已有 comparison、代码入口、许可证、环境和可复现性状态；
5. 在这些结构化结果之上生成 `ResearchMaterialAssessment`：告诉用户哪些论文、数据集/场景、comparison、指标、split、标签语义、消融或资源信息还缺。

Analysis 可以继续处理本地材料、发现候选数据集/论文/仓库、更新知识 artifact 和重新评估缺口，也可以生成尚未锁定的切片/协议建议，但不能写科研代码、锁定正式协议、启动实验、改变 comparison 清单或生成未经确认的科学结论。用户补充材料后重新 `scan`/`intake`，它只重做受影响的节点；当材料和协议足够时，用户切到 Research。

## Research 档位（科研执行）

Research 档位负责论文知识、Protocol Synthesis、comparison gate、IdeaCard、quick/standard 实验、消融、Result Analyst、handoff、ResearchRun、checkpoint 和 Decision/Event。它自己的解析与执行管线遵守原始输入只读、idea 隔离、实验 scheduler 和协议/指标门禁。

## Agent 入口：项目内的通用 DSH coding agent

科研会话的自然语言按权限档位分流：

- **Research 档位**：`ideaseek ask` 的 supervisor 分类与现有 CLI use-case 执行——只读查询即时回答，高影响请求生成待审批 Decision，绝不静默执行；问候与能力问题由确定性拦截即时回答（不烧模型）。
- **Analysis 档位**：自然语言进入材料评估与研究准备流程；只写知识和缺口 artifact，缺 required 材料时给出阻塞和下一步，不启动正式实验。

`ideaseek agent`（以及 TUI 里的 `/agent`）**不是第三个权限档位**，而是一个通用 coding agent，只是它的 cwd 落在项目里、每一回合被审计：

- 权限预设直接沿用 DSH 默认的 `workspace-write` + `ask`——项目内读写、受限 shell、测试工具本来就是它的能力，写入逐次问询。IdeaSeek 不额外收紧目录，也不存在"需要为它开放什么"这一步；`DSH_PERMISSION_MODE=read-only` 只用于模型抽取的 HarnessAdapter 路径，与 agent 入口无关。
- **它不要求当前目录是 IdeaSeek 项目。** 在任意仓库里 `ideaseek agent "<指令>"`（TUI 里 `/agent <指令>`）就是一轮通用 coding 会话：运行时、审批、`--resume` 全都照常。此时没有科研侧保证——不记 RunEvent、不做原始输入漂移侦测、不注入项目摘要——CLI 会把这一条明说出来，而不是假装保证仍在。进了 IdeaSeek 项目，三项自动生效。
- **通用回合也留一份可回看的流水**：`~/.ideaseek/agent-sessions.json`（跟随 `IDEASEEK_USER_CONFIG`）记录每个会话的首轮指令作标题、最近一轮、累计回合数、所在目录和 `general`/`project` 归属；`ideaseek agent --list` 或 TUI `/agent`（不带指令）就是那个列表，`--resume <id>` 直接续上。完整的对话逐句正文仍然只在 DSH 自己的 session 历史里，IdeaSeek 不复制第二份事实源；列表上限 50 条，旧的自动淘汰。
- **装了就是通用 agent**：在没有项目的目录里裸 `ideaseek`（真终端）打开的就是通用会话，footer 徽标显示 `GENERAL` 而不是伪造一个研究档位；那里每一句自然语言直接是一轮 coding turn（等价于 `/agent <指令>`），因为没有被保护的科研会话需要区分。一旦目录里有 `research.yaml`，同一行输入立刻回到 `ideaseek ask` 的科研分流。
- 每条自然语言是一次**真实 DSH coding-session turn**（项目为 cwd、逐回合记审计事件）；TUI 内跨消息自动 `--resume` 续同一 session，**跨 TUI 重启**也从 `knowledge/agent-sessions.json`（最新在前）自动续接上一段对话——id 在 DSH 侧失效时记日志回退新建，绝不卡死后续消息（想新开对话：删除该注册表条目）。首轮注入项目上下文摘要，使通用 agent 看得到研究问题与知识 artifact 的位置。无凭据/运行时不可用时诚实失败并给出 `ideaseek doctor` 指引。**TUI 内工具审批已透传**（输入行切换为 `y allow once · n reject` 提示，应答回传子进程；行式路径用裸 y/n 行，见 TERMINAL_UX 审批界面）；未 opt-in 的普通管道脚本仍默认拒绝（never auto-approve），TTY 下仍走原生问询。

### 不禁止写入，但侦测写入

两个科研档位仍受项目根路径、网络、凭据和容器策略限制；修改锁定协议、comparison 清单或已提交结果仍要走 Research Decision/Approval。Agent 入口的策略不同：**它改任何文件都是允许的，但改完会被发现。**

一轮 agent 会话结束后，IdeaSeek 拿磁盘现状与 `knowledge/input-manifest.json` 记录的内容 hash 比对。`papers/`、`datasets/`、`comparisons/upstream/` 被修改、新增或删除时：

1. 相关输入标注 dirty，`ideaseek stale` 列出漂移文件与受影响范围；
2. 用户 `scan` 之后输入 manifest 与 hash 变化，依赖其 snapshot 的 ideation round、分析与 check-report 节点按既有 snapshot 规则失效；
3. `next` 和报告明确说出哪些已提交结论不再可复核，并给出恢复路径（还原原文件，或处理后经 `datasets link` 重新晋升为新版本）。

保持硬的只有一条，而且是存储语义而非工具限制：已提交实验结果、锁定协议和 handoff 记录 append-only，重试保留 attempt 历史。这样通用 agent 拿到全部能力，报告仍然不说谎。

`PROGRESS.md` 的 Agent 真机验收与 conformance tests 完成前，不承诺完整的 Claude Code 式跨回合工具审批体验。

## Full Research / Publication 模式

这是 Research 在 idea 达到 `HANDOFF_READY` 后的显式升级模式。用户批准后，IdeaSeek 可以发现/下载公开数据、运行 full-scale 实验、生成图表、调用 ARIS-style 写作/claim audit/reviewer workflow，并交付论文草稿和完整复现包。下载、全量训练和论文主张都有独立预算、checkpoint 和审批；它不是普通探索的默认行为。

数据获取链路是 `datasets discover` → `datasets authorize --grant` → `datasets acquire` → `datasets link`：acquire 只把**单个公开下载文件**暂存进 `datasets/`（仅 https、拒绝 URL 内嵌凭据、URL query 中的签名 token 不落盘也不打印、文件名净化且不得逃逸出 datasets、拒绝覆盖已有文件和残留 `.part`、按 `--max-gib` 流式截断、Content-Length 预检、sha256 记录进 `knowledge/dataset-acquisitions.json` 与 Decision 事件），并且要求 `runtime.allow_network: true`；大型或未知规模在 guided 模式下必须 `--confirm`。acquire **不解压、不晋升**：归档仍走 `scan`/intake 的安全解压门禁，晋升到 `user-provided`/`validated` 仍只有 `datasets link` 一条路径。`registration`/`request`/`local-mount` 类数据没有可下载的 URL，acquire 会拒绝并回显记录的获取说明。

## 切换方式

交互终端：

```text
/mode research
/mode analysis
/mode
/agent <指令>：起一轮通用 DSH coding 会话（不参与 Shift+Tab 轮换）
/open         在没有项目的目录里列出已注册项目；/open <名称|路径> --confirm 进入其中一个（通用会话回到科研工作的门）
Shift+Tab：在 Research 和 Analysis 两个权限档位之间循环（终端支持时）
```

命令行：

```bash
ideaseek interactive --mode research
ideaseek interactive --mode analysis
ideaseek mode
ideaseek mode research --force
ideaseek agent "<指令>" [--resume <id>] [--deny-tools]
```

切换档位时 footer 显示醒目的当前档位和 Shift+Tab 提示；切换输出保持两行——档位迁移与审计事件（含事件号），再附新档位的首条权限提示，完整权限摘要用 `/mode` 查看，不创建第二个后台 run。Analysis 不能绕过 Research 的协议、comparison 和实验门禁。`/agent` 改的是入口而不是档位：科研档位保持不变，coding 会话结束后输入漂移侦测照常运行。

## 产品边界

通用 Agent 能力直接复用 DSH 的 session/runtime/tool loop 和它自带的权限预设；IdeaSeek 只负责项目边界、角色 capability profile、审计、输入漂移侦测和 UI，不复制 DSH 的 CLI、Agent Loop、上下文管理或工具系统，也不在 DSH 之上再造一层目录级写入限制。
