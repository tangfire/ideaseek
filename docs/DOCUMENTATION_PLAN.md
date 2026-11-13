# IdeaSeek 文档站规划

## 文档分层

IdeaSeek 文档分为四层，避免把开发设计直接塞给普通用户：

1. **首页/README**：一句话定位、安装、5 分钟 Quickstart、核心限制和链接；
2. **User Guide**：安装、项目、模型、输入、运行、交互、结果、恢复和 handoff；
3. **How-to**：配置本地 embedding、导入 comparison、处理私有仓库、后台运行、备份恢复、开发插件；
4. **Reference**：CLI、配置、模型路由、数据契约、事件、插件 SDK、错误码；
5. **Developer/Operations**：架构、DSH 集成、代码规范、Git、发布和安全。

## 推荐目录

```text
docs/
  USER_GUIDE.md
  DOCUMENTATION_PLAN.md
  getting-started/
  concepts/
  tutorials/
  how-to/
  reference/
  operations/
  development/
```

当前仓库保留 Markdown 作为规范来源，并提供 `docs/site/index.html` 自包含的可浏览使用指南原型，可直接本地打开，无需安装文档框架或运行外部服务。后续若部署正式文档站，可评估 VitePress、Docusaurus 或 MkDocs；命令/config 内容必须从 schema 或规范文档同步，避免手册漂移。

## 文档质量要求

- 每条用户命令都给出预期输出或下一步；
- 每个长任务操作说明暂停、恢复和失败路径；
- 明确哪些功能是 Linux 正式支持、哪些是 WSL2/实验性；
- 明确 IdeaSeek 只运行 smoke/quick/standard，full-scale 由用户执行；
- 任何示例使用合成路径、假 key 和小 fixture；
- 发布前从零机器按 Quickstart 跑一遍；
- 每个版本检查 CLI、配置和文档的版本一致性。
- HTML 指南必须标记“当前可用/开发中/规划中”，不能把 Progress 未完成项写成已交付能力。
