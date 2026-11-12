# IdeaSeek 依赖与成熟组件策略

本文档把“能复用就不重写”落实为开发门禁。IdeaSeek 是科研工作流产品，不应重新实现 Agent Runtime、通用终端渲染、通用进程管理、通用 schema 校验或通用 GitHub API。

## 评估顺序

新增模块前按以下顺序检查：

1. DSH 是否已经提供 Agent、Session、Tool、Subagent、provider、上下文和权限能力。
2. ARIS 是否已经提供对应的科研 skill、workflow、reviewer、审计或报告能力。
3. 现有仓库依赖是否已经覆盖需求。
4. 是否存在许可证清晰、版本稳定、跨 Windows/Linux 可验证的成熟开源包。
5. 能否通过配置、插件或薄 adapter 接入。
6. 只有外部组件无法满足 IdeaSeek 的状态、权限、资源、checkpoint、恢复或结构化结果契约时，才新增自有实现。

## 当前组件边界

| 能力 | 首选复用来源 | IdeaSeek 自己保留的部分 |
|---|---|---|
| Agent Runtime | DSH | HarnessAdapter、角色权限和科研任务映射 |
| 科研 workflow | ARIS | IdeaCard、ExperimentSpec、RunResult、Artifact、Decision、RunEvent 和 checkpoint |
| TUI | Ink 或同等级成熟 TUI 框架 | UI 与 use-case 的 adapter；plain/json 仍走行式输出 |
| CLI 参数 | Commander | 命令到 application use-case 的映射 |
| 契约校验 | JSON Schema + 成熟校验器 | schema 版本、迁移、跨 TS/Python 的单一权威契约 |
| 子进程 | 成熟跨平台进程库或已验证 adapter | 租约、超时、取消、失败分类和恢复语义 |
| GitHub | Git CLI + 可选 API adapter | 来源、commit、license、权限和审计记录 |
| PDF/科学解析 | Python 生态成熟库 | 解析器版本、证据定位、哈希绑定和失败回退 |
| 检索 | FTS/BM25 + 本地 embedding | 混合排序、缓存指纹和证据免责输出 |
| 容器/GPU | Docker/Podman、系统探针 | 资源准入、排队、实验公平性和运行快照 |

## 新依赖门禁

每个新依赖必须记录：用途、版本、许可证、来源、维护状态、Windows/Linux 验证、替代方案、adapter 边界和测试方式。依赖不能：

- 创建第二套 Agent Loop、Session、任务数据库或实验队列；
- 绕过 IdeaSeek 的权限、预算、comparison gate、checkpoint 或事件审计；
- 把用户原始数据、凭据或完整日志上传到未授权的外部服务；
- 让 interactive、plain、JSON 三种输出路径出现不同的业务语义。

迁移通过 conformance/regression tests 后，应删除旧的重复默认实现；不要长期维护两套默认 workflow 或两套默认 TUI。

## 当前待办

- 以 Ink 完成 interactive TTY 应用壳，并删除旧的默认 readline/ANSI 重绘路径。
- 评估 JSON Schema 校验器，统一 TypeScript、Python worker 和 ARIS 结构化契约。
- 评估跨平台子进程 adapter，覆盖 Windows/Linux 的超时、取消和进程树回收。
- 评估 GitHub API adapter，仅用于元数据、license、release 和限额，不替代 Git clone。
- 仅在需求出现时评估文件扫描、watch、结构化诊断日志和扩展归档解析库。

