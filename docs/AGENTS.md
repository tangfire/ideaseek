# IdeaSeek 开发 Agent 指令

你正在开发 IdeaSeek：一个以 DeepSeek Harness（DSH）为 Agent Runtime 的多 Agent 科研工作流平台。目标是让用户提供研究问题、论文和数据集后，平台完成论文证据整理、自动发现/复现对比方法、环境修复、多个 idea 的代码实现、小规模并行实验、消融和结果驱动迭代。

## 必读文档

开始任何实现前，按顺序阅读：

1. `README.md`
2. `plan.md`
3. `ARCHITECTURE.md`
4. `WORKFLOW_SPEC.md`
5. `DEVELOPMENT.md`
6. `IMPLEMENTATION_ROADMAP.md`
7. `PROGRESS.md`

首次建仓或运行时环境变更时，补读 `BOOTSTRAP_DEVELOPMENT.md`。

按任务补读：`AGENT_ROLES.md`、`CLI_SPEC.md`、`DATA_CONTRACTS.md`、`OPERATIONS.md`、`EVALUATION.md`、`EXPERIMENT_PORTFOLIO.md`、`CODE_STYLE.md`、`GIT_WORKFLOW.md`。

涉及 CLI/TUI、实时事件、banner、审批或 attach/replay 时，补读 `TERMINAL_UX.md`。

涉及用户流程、成本、通知、报告导出、归档、恢复或发布验收时，补读 `PRODUCT_REQUIREMENTS.md`。

涉及数小时/数天实验、idea 多轮迭代、训练恢复或长期 supervisor 时，补读 `LONG_RUNNING_WORKFLOWS.md`；不要把会话 resume 当作 workflow resume。

涉及配置、报告引用、实验结论或发布时，必须补读 `CONFIG_SPEC.md`、`PROVENANCE_AND_CITATIONS.md`、`RESEARCH_INTEGRITY.md` 和 `RELEASE_CHECKLIST.md`。
涉及具体研究方向、数据切分、指标或实验协议时，必须补读 `DOMAIN_ADAPTERS.md`，并先确定该方向适配器的契约。

## 开发顺序

严格按 roadmap 从 Phase 0 开始。每次只实现一个可验证的垂直切片：

```text
契约/状态 → 最小实现 → 成功测试 → 失败/恢复测试 → 文档 → commit
```

不要先实现 20 个 Agent 的空壳。先让以下链路真实可用：

```text
init → 创建项目 → 创建 task → 假 Worker 执行 → artifact 提交
→ status/next 显示 → 进程重启 → resume 继续

## 持续开发协议（防止长时间思考不落地）

开发 Agent 必须采用有界循环，而不是无限探索：

```text
检查状态 → 选一个最小切片 → 读最少必要文件 → 写代码/测试
→ 运行目标测试 → 修复 → 文档 → 小 commit/push → 下一切片
```

- 连续搜索、阅读或设计超过 10 分钟仍没有 diff 时，必须停止探索并写一个最小可运行实现或测试。
- 同一错误最多尝试 3 次；没有新证据就记录 blocker，转到下一个独立任务。
- 相关测试优先于全量测试；全量测试超时或有环境性失败时，保留目标测试证据并继续处理其他模块。
- 每个阶段汇报后必须继续执行，不得以“下一步建议”结束。
- 如果主线有未提交改动，先保护并在其范围内工作；不要 reset、clean、checkout 或覆盖它们。
- 上下文接近上限时，只保留任务目标、当前 diff、已通过测试、已知 blocker 和下一切片，继续工作。
```

## DSH 约束

- 使用 DSH 公开的 Cordis plugin、bundle、Agent、Session、Tool、Subagent、profile 和 SDK 接口。
- 不直接改 DSH 核心，不复制 DSH Agent Loop，不让 DSH session 替代科研工作流数据库。
- 通过 `HarnessAdapter` 隔离 DSH 版本变化。
- 每个角色使用 capability profile，工具、路径、网络、资源和委派权限最小化。
- DSH 的 developer preview 版本必须锁定，并写兼容性测试。

## 数据和安全约束

- 用户论文、数据、comparison upstream 和 GitHub 凭据不能进入 Git。
- 原始输入和 `upstream/` 只读；修改只能写 worktree 或对应 idea 目录。
- 输入目录是宽松的：先用 Workspace Intake/manifest 识别和分组用户文件；不要假定目录名就是语义，也不要移动、删除或覆盖原始文件。
- Agent 生成的代码和第三方仓库在隔离容器中运行，实验默认禁网。
- secret 不得进入 prompt、事件、日志、artifact、错误栈、容器环境或测试输出。
- 任何长任务必须有租约、heartbeat、checkpoint、幂等提交和可恢复状态。
- 不把 `paper-reimplementation` 当作官方代码；不把单次小数据提升当成已证明创新。

## 提交规则

- 不直接向 `main` 推送；使用短分支和小提交，详见 `GIT_WORKFLOW.md`。
- 每完成一个模块或垂直切片就提交，不要积累跨模块巨型 diff。
- commit 使用 Conventional Commits，并在正文说明恢复、安全和测试影响。
- 提交前运行格式化、类型检查、相关测试和 `git diff`/secret 检查。
- 最终汇报必须包含：完成内容、commit ID、测试命令与结果、已知限制、下一模块依赖。
- 每完成一个模块，必须更新 `PROGRESS.md` 对应 checkbox 和模块交付记录；没有真实测试和 commit 不得打勾。

## 必须覆盖的失败路径

每个新任务至少测试：超时、取消、重复提交、租约过期、Worker 崩溃、输出损坏、输入版本变化和权限拒绝。需要持久化的输出先写临时文件，校验哈希后原子提交，再更新数据库状态。

## 不要做的事

- 不要把 1000 篇论文塞进一个 Agent 上下文。
- 不要启动无上限的 Agent、修复循环或 GPU 实验。
- 不要因一个 required comparison 失败就跳过它进入 idea 阶段。
- 不要让 Agent 直接取得宿主 shell、全局 Python、全局 CUDA 或凭据读取权限。
- 不要为了让测试通过而删除恢复、审计、权限或证据校验。


## 判断归 Agent，边界归平台

平台是多 Agent 的（集成 DSH 与 ARIS），所以**需要理解语境才能得出的结论应交还 Agent 判断**，不要在 TS 里写关键词表、枚举表或启发式规则去替 Agent 下结论——那种代码只会变成一张越来越长、且在新情况下必然失效的维护清单。

- 属于"判断"、应由 Agent 做的（可换不可省）：错误属于哪一层（spec/build/weights/resolution/exec/code/plan）、失败是否值得再试、是否是环境阻塞、数据集结构与语义解释、实验设计与结论强度、代码修复方案。判断结果必须带引用的证据（如 `failure-diagnosis-v1` 要求 `evidence[]` 逐条摘录日志），没有证据的判断等于猜测。
- 属于"边界"、必须由平台硬编码的（不可交给模型）：路径不得越出 `src/`、不得写入或删除清单之外的文件、凭据不得进入提示/事件/日志/错误栈、自称 synthetic/placeholder 的指标不得作为结果、成本与轮数上限（控花费而非控结论）、schema 校验与幂等键。
- 判据：**若需要为新情况扩表才能正确回答，那它就是判断，应交给 Agent 并让它引用证据。**
- 契约优先复用 ARIS 的散文规范（`aris-skills/shared-references/*`）与已 vendored 技能，而不是自造分类；同时保留平台的机械不变量作为兜底，Agent 不可用时退回机械分类，而不是编造结论。
