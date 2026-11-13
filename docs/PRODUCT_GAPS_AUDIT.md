# IdeaSeek 产品缺口审计

这份文档记录从真实用户角度反推出来的产品要求。架构正确不代表用户用起来顺畅；每项都要进入产品需求、CLI 规范或 `PROGRESS.md`，不能只停留在讨论。

## 已补充的关键缺口

### 1. 自然语言和命令并存

用户在 `ideaseek ›` 中不应只能输入 slash 命令，也应能直接问：

```text
为什么 method-b 还没通过？
优先验证 idea-002，不要再给 idea-001 分配 GPU。
把本轮预算限制在 5 个 GPU 小时。
这个 idea 在 dataset-b 失败的原因是什么？
```

自然语言消息由 Supervisor 解释成可审计的查询、建议或 Decision；高影响操作仍需要确认。自由文本不能直接绕过任务状态、预算或权限。

### 2. 运行前 dry-run

用户可以先看计划而不启动高成本任务：

```bash
ideaseek plan --question "..."
ideaseek plan --run <run_id> --json
```

计划显示输入、论文任务量、comparison、idea 上限、数据切片、模型 route、预计 token/GPU/磁盘、审批节点和可能阻塞。用户确认后才执行。

### 3. 用户级与项目级配置

- 用户级：模型 provider、credential 引用、默认 route、embedding 缓存和通知偏好；
- 项目级：研究问题、论文/数据路径、comparison、预算、自治模式和实验策略；
- run 级：输入 snapshot、解析后的配置、模型 route、数据 slice 和协议版本。

`ideaseek config explain` 显示每个生效值来自哪里；项目配置不能读取或覆盖用户 secret。

### 4. 运行中干预

用户可以在不重启 run 的情况下：

- 暂停某个 idea 或 comparison；
- 调整后续 idea 优先级；
- 限制/释放 GPU 配额；
- 标记某个 comparison 为暂不适用（需原因）；
- 提供数据语义修正；
- 要求重新分析某个论文簇；
- 将自然语言建议提交为待审批 Decision。

已经提交的 artifact 不被覆盖；变更只影响尚未开始或明确依赖新配置的节点。

### 5. 多项目与目录安全

用户可能在同一服务器上维护多个研究目录。CLI 默认只操作当前项目；`ideaseek projects` 可列出注册项目和最后状态；项目锁阻止同一目录的冲突 run。所有路径在 project root 或显式只读挂载范围内解析，不能因 `cd` 或 symlink 变化越权。

### 6. 结果生命周期

用户需要知道哪些 artifact 可以删除、哪些是恢复必需品。提供缓存/日志/切片清理预览：

```bash
ideaseek cleanup --dry-run
ideaseek cleanup --cache
ideaseek archive --run <run_id>
ideaseek export --run <run_id> --to <path>
```

清理只删除平台拥有的可重建缓存；原始输入、锁定协议、PaperCard、IdeaCard、RunResult 和 handoff 默认保留。

### 7. 通知和无人值守

后台任务在完成、失败、需要确认、额度耗尽或长时间无心跳时可发送本地通知或可选 webhook。通知只包含脱敏摘要和 run/task ID；详细内容仍需用户 attach 到项目。

### 8. 真实用户反馈

报告和 CLI 都能标记：有用、无效、已有工作、实验协议错误、数据解析错误、baseline 不公平。反馈进入 Decision/Event，可选择加入 gold set；默认不把私有项目上传到平台共享评测集。

## 当前未完成项

原有清单中的自然语言 REPL、plan/dry-run、用户/项目配置、多项目锁、cleanup/archive/export、通知、反馈和部分用户旅程已在后续阶段实现，逐项状态以 `docs/PROGRESS.md` 为准。

当前仍未完成的能力以 `PROGRESS.md` 未勾选项为唯一实施来源，重点包括：真实 `HANDOFF_READY` 与第二任务族的研究验收、Full Research comparison 规划/公平性/全量执行与证据审计、完整用户旅程的剩余真实环境验收、分层硬化，以及发行包/安装/升级/恢复演练。依赖真实研究材料、GPU、外部凭据或发布环境的项目必须标为外部验收，不能用模拟测试勾选完成。

## 产品验收原则

用户任何时候都应该知道：平台在做什么、为什么做、花了多少、卡在哪里、下一步是什么、怎样暂停、怎样恢复、哪些结果已经可信、哪些仍然未知。若只能从日志和源代码猜答案，产品功能不算完成。
