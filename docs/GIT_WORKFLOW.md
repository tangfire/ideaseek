# IdeaSeek Git 工作流

## 仓库与分支

- GitHub 私有仓库作为唯一代码源；不要把论文、数据集、API key、模型产物和大日志提交进 Git。
- `main` 始终保持可安装、可启动和通过基础检查。
- 每个模块使用短分支，例如 `feat/workflow-state`, `feat/dsh-adapter`, `fix/checkpoint-recovery`。
- Agent 不直接向 `main` 推送，除非用户明确授权；默认提交到分支并生成可审查 diff。
- 一个提交解决一个逻辑问题，避免把格式化、重构和功能混在一起。

## 开发 Agent 的循环

1. 阅读 `README.md`、`plan.md`、相关契约和当前模块代码。
2. 在 issue/任务中写明目标、依赖、状态转换、权限影响和验收条件。
3. 先实现最小垂直切片，例如“创建 task → 执行假 Worker → 保存 artifact → status 显示”。
4. 运行格式化、类型检查、单元测试和相关集成/smoke test。
5. 检查 `git diff`，确认没有 secret、数据、大产物、无关改动或破坏原始输入。
6. 提交一个清晰 commit，更新文档和变更说明。
7. 在模块完成时停下来汇报：完成内容、测试、已知限制、下一模块依赖和 commit ID。

## Commit 规范

使用 Conventional Commits：

```text
feat(workflow): persist task leases and run events
fix(checkpoint): recover uncommitted artifacts after restart
feat(dsh): add paper extractor capability profile
test(comparison): cover repair retry states
docs(cli): define attach and replay commands
refactor(storage): isolate artifact store interface
chore(deps): pin dsh runtime version
```

标题使用现在时、简短、说明行为；正文说明为什么、恢复/安全影响和测试。破坏兼容的变更在正文明确写 `BREAKING CHANGE:`。

## 模块提交门槛

- **骨架/CLI**：`init`, `status`, `next` 可运行，目录创建幂等。
- **状态/队列**：租约、重试、取消、幂等和故障注入通过。
- **DSH 集成**：profile、工具、权限和 session 映射有测试；不改 DSH 核心。
- **论文管线**：PaperCard schema、证据定位和增量处理通过 gold set。
- **Comparison**：官方代码/重实现来源清楚，upstream 不变，worktree diff 可审查。
- **实验**：ExperimentSpec/RunResult 完整，容器和资源限制生效。
- **实时交互**：后台运行、断线 attach、事件回放和 pause/resume 可用。

未达到门槛的模块可以提交，但必须标记为 `WIP`，不能宣称该阶段完成。

## 禁止提交

`.env`、API key、GitHub token、SSH 私钥、用户 PDF/数据、模型权重、容器缓存、完整运行日志、临时数据库和个人路径。使用 `.gitignore` 与 pre-commit secret scan 双重保护。

