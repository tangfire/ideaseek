# 发布与升级清单

## 发布前

- DSH、Node、Python、容器和已启用插件版本已锁定；升级影响有说明。
- 数据库迁移可前滚/回滚，迁移前有备份；旧 run 可读。
- 配置、PaperCard、Comparison、Idea、ExperimentSpec 和 RunEvent schema 有版本号。
- `main` 可安装、`ideaseek init/doctor/next` 可用，最小流程通过。
- 论文 gold set、comparison 复现集、固定实验和故障注入回归通过。
- secret scan、依赖漏洞检查、许可证检查和容器权限检查通过。
- Linux 正式环境通过；Windows/WSL2 仅声明已验证能力。
- 报告模板、引用导出、增量处理和 checkpoint 恢复验证通过。

## 变更分级

- **Patch**：错误修复，不改变 schema、权限或实验语义。
- **Minor**：向后兼容的 CLI、插件或字段增加；旧配置和旧 artifact 可读。
- **Major**：DSH 版本、状态机、schema、权限或实验语义不兼容；必须迁移指南和明确用户动作。

## 发布后

记录版本、构建 hash、DSH commit、插件 bundle、模型/provider 配置模板和已知限制。保留可回滚包。观察任务失败率、API 成本、GPU OOM、队列等待、checkpoint 恢复和报告质量；发现结果质量回退时先停止自动升级和高成本自动运行。

