# IdeaSeek 根目录开发入口

这是 IdeaSeek 的仓库根目录。开始任何开发前，必须先阅读：

1. `docs/AGENTS.md`
2. `docs/README.md`
3. `docs/plan.md`
4. `docs/ARCHITECTURE.md`
5. `docs/WORKFLOW_SPEC.md`
6. `docs/DEVELOPMENT.md`
7. `docs/IMPLEMENTATION_ROADMAP.md`
8. `docs/PROGRESS.md`

所有详细开发约束、DSH 边界、Agent 权限、恢复语义、代码规范和提交规则以 `docs/` 中的文档为准。完成模块后更新 `docs/PROGRESS.md`，通过测试并提交小 commit 后才能标记完成。

## 持续执行与防卡死

- 开始先检查 `git status`、当前 diff、最近提交和 `docs/PROGRESS.md`，不得重复实现已经提交的功能。
- 连续分析、搜索或阅读不得超过约 10 分钟而没有代码、测试或文档 diff；先做最小可验证切片，再扩展。
- 每个垂直切片完成后立即运行目标测试、更新文档、创建小 commit 并 push，然后继续下一个未完成切片。
- 遇到测试、API、依赖或凭据阻塞时，最多进行 3 次有差异的修复尝试；随后记录阻塞，转向不依赖该条件的下一个模块。
- 不得通过重复调用、无限修复循环或无限 Agent fan-out 消耗上下文和预算。
- 上下文变大时先压缩为当前状态、未提交文件、测试结果和下一步，再继续；不得清空会话后重新扫描整个仓库。
- 只有真实实现、测试和 commit 都完成后才能勾选进度；禁止用设计文档或 spike 结果冒充产品完成。
