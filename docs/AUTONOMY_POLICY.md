# IdeaSeek 自动化与人工确认策略

IdeaSeek 的目标是把科研探索自动化，而不是让模型静默替研究者做所有科学决定。默认采用“自动执行低风险工作、在高影响节点做轻量确认”的渐进式策略。

## 三种运行模式

### Guided（默认）

平台自动完成论文解析、证据整理、检索、comparison 扫描、代码修复、数据画像、quick 切片、smoke test 和有限实验。在以下节点暂停并给出可执行选择：

- 研究问题和范围解释；
- 数据集样本单位、标签、客户端/域/时间语义；
- ExperimentalProtocolProposal 锁定；
- required comparison 清单和排除项；
- idea 进入代码/实验的数量和预算；
- `HANDOFF_READY` 交付确认。

用户只确认摘要、候选和影响，不需要手工操作每个 Agent。

### Autonomous

用户在配置中显式允许无人值守。平台可以自动通过上述门槛，但仍受硬预算、权限、数据快照、required comparison 和安全规则限制。每次自动决定都写 Decision/Event，最终报告列出自动决定、依据和未确认风险。

### Review-only（项目配置级）与 Analysis（会话档位级）

- **`Review-only`**（`research.yaml: policy.autonomy_mode`）：项目级的只读配置——只做论文、数据、comparison 和实验协议分析，不写代码、不锁协议/公平性锁、不启动实验或交付 handoff。
- **`Analysis`**（`.research/session.json` 会话档位）：交互与 CLI 准备期的临时只读锁——通过 `assertEffectiveAutonomy` 与 `Review-only` 共享同一套写操作/科学锁定拦截，即便项目配置是 `guided` 或 `autonomous`，只要当前处于 `Analysis` 档位就一律拒绝写科研代码、锁协议、改 comparison 必选集或启动实验；准备完成后切回 `Research` 即恢复 `guided`/`autonomous` 策略。

## 不应静默决定的事项

模型不能在没有记录和确认的情况下改变研究问题、数据语义、测试集用途、主指标、comparison 排除理由、idea 的科学假设或报告中的创新表述。Agent 可以提出默认方案和替代方案，但关键选择必须可追溯。

## 通用 Agent 入口不是一种自治模式

`ideaseek agent` / TUI `/agent` 走 DSH 自带的 `workspace-write` + `ask` 预设：它不是 Guided/Autonomous/Review-only 的第四档，也不受科研档位的写入面限制。策略从「拦住写入」换成「不静默接受写入」——工具调用逐次问询、回合进入审计，原始输入一旦被改动由漂移侦测标注 dirty 并使下游节点失效（见 [MODES.md](MODES.md)）。高影响科学节点仍按上面的模式规则暂停。

## 交互原则

- 一次确认尽量合并成一个摘要，不打断用户确认每个小任务；
- 提供推荐选项、依据、预计成本和风险；
- 用户不回复时，只有显式 `Autonomous` 配置可以自动继续；
- 任何暂停都可以通过 `ideaseek next` 看到阻塞原因和下一条命令；
- 结果报告区分“平台自动决定”“用户确认”“用户未确认的推断”。

## 设计目标

理想体验是：用户只在研究方向、数据语义、协议、候选 idea 和最终 handoff 这些科学节点介入；论文阅读、检索、代码修复、环境准备、切片、quick 实验、日志分析和 checkpoint 恢复由平台持续完成。
