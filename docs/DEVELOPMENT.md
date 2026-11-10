# 给后续开发 Agent 的实现约束

## 开始工作前

1. 先读 `README.md`、`plan.md`、`ARCHITECTURE.md`、`WORKFLOW_SPEC.md` 和本文件。
2. 确认当前任务属于哪个 roadmap phase，不跨阶段实现未定义的功能。
3. 查找并遵守 DSH 仓库的 `AGENTS.md`、插件 README、公开 API 和 profile 约束；不要根据内部实现猜接口。
4. 先写或确认数据契约、状态转换和失败语义，再写代码。

## 实现规则

- 保持 DSH、科研工作流、Worker 和实验执行的边界；不把数据库状态藏在 Agent session。
- 所有长任务可恢复、可取消、可重试；写 artifact 使用临时文件、哈希和原子提交。
- 所有外部输入不可信；Agent 生成代码和第三方仓库进入隔离环境。
- 所有角色使用 capability profile；添加工具时同时写路径、网络、资源和审计规则。
- 原始输入只读；comparison upstream 只读；idea 只写自己的 workspace。
- 不把 `paper-reimplementation`、单次小数据提升或模型自评写成已证明创新。
- 不写入 secret，不在测试输出中打印 token；网络调用要可关闭且有明确错误。
- 代码、配置、prompt/schema、数据库迁移和报告模板都要版本化。

## 每个变更必须回答

- 影响哪些状态、对象和 checkpoint？
- 崩溃、超时、重复提交和输入变化时会怎样？
- 是否改变了 Agent 工具权限或数据外发边界？
- 如何验证成功和失败路径？
- 是否需要更新 CLI、JSON schema、报告、回归集和文档？

## 不允许的捷径

- 不用一个超长上下文处理全部论文。
- 不启动无上限的 Agent、GPU 任务或自动修复循环。
- 不因一个 baseline 失败就默默进入 idea 阶段。
- 不直接修改 DSH 核心来绕过插件边界。
- 不让 Agent 直接执行宿主 shell、读全局凭据或覆盖用户目录。

## 完成定义

功能有结构化日志、错误类别、checkpoint 语义、最小权限测试和文档；正常路径、断线/重启路径和拒绝路径都经过验证。没有测试或无法说明恢复语义的功能不能标记为完成。


