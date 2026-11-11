# IdeaSeek 代码规范

## 总原则

代码优先保证边界清楚、可恢复、可测试和可审计。不要用隐式全局状态、未记录的 side effect 或 Agent 自由文本作为业务协议。

## 分层规则

- CLI/REPL 只负责解析输入、显示状态和调用 use-case；不直接写数据库、调用 DSH 或执行 shell。
- Domain 规则只依赖纯类型、schema 和 ports；不依赖 Commander、SQLite、Node child_process、DSH SDK 或 Python。
- Application/use-case 负责事务边界、门禁、Decision/Event 和任务编排；它通过接口使用基础设施。
- SQLite/Postgres、DSH、GitHub、Docker/GPU、Python Worker 都属于 adapters；必须可用 fake 实现测试。
- 需要跨层调用时先增加稳定 contract/port，不通过 import 内部实现或全局单例绕过边界。
- 同一个业务规则只能有一个权威实现；CLI 命令、REPL 命令和 JSON API 复用同一个 use-case。

## TypeScript / DSH 插件

- 遵循 DSH 仓库已有 ESLint/formatter/TypeScript 配置，不另造风格。
- 开启严格类型；公共插件 API、配置和事件使用显式类型，避免 `any`。
- Cordis plugin 的注册、监听和资源必须有对应卸载/cleanup；禁止直接改 DSH 核心包。
- 工具参数和输出使用 JSON Schema；错误使用稳定的错误码和结构化上下文。
- 异步任务必须支持 AbortSignal、超时、幂等键和可重试边界；禁止吞掉异常。
- Agent prompt、model route、schema 和工具版本作为配置/常量版本化，不散落在业务代码中。

## Python Worker

- 使用 `pyproject.toml`、锁定依赖和格式化/静态检查工具；公共函数写类型标注。
- Worker 只处理任务协议，不自己维护第二套 Agent Loop 或隐式队列。
- 文件写入使用临时文件、fsync（适用时）、哈希校验和原子替换；原始输入只读。
- 训练和数据处理显式接收 `ExperimentSpec`，不得从当前 shell 环境偷偷读取实验参数。
- 日志使用结构化字段，secret、完整 prompt 和敏感数据禁止写入。

## 目录与命名

- 模块按领域划分：`workflow`、`knowledge`、`comparison`、`idea`、`experiment`、`credentials`、`runtime`。
- 数据库表和 JSON 字段使用稳定的 snake_case；TypeScript/Python 内部变量遵循各自生态惯例。
- ID 使用带类型前缀的稳定字符串，例如 `run-...`、`task-...`、`idea-...`。
- 时间统一使用 UTC 存储，CLI 按用户时区显示。
- 业务代码不直接拼接 shell 命令；使用参数数组和安全 subprocess API。

## 测试

- 状态机、schema、权限和恢复语义优先写单元测试。
- 工具写集成测试；实验容器写最小 smoke test；不写只重复实现的测试。
- 每个新任务类型至少测试成功、超时、取消、重复提交、租约过期和输出损坏。
- 使用假的模型、GitHub 和 GPU 适配器测试，不在 CI 中依赖真实 secret 或昂贵 GPU。

## 文档与可观测性

公共行为变更同时更新 CLI、数据契约和 README。每个长任务发布 RunEvent，错误日志能指向 task/run/artifact ID。代码注释解释约束和原因，不重复代码表面含义。

