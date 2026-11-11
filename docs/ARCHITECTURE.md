# IdeaSeek 架构

## 总体边界

```text
CLI / attach client
        │ event stream + commands
Workflow Supervisor ── Workflow DB / RunEvent / Artifact Store
        │ task queue
        ├── DSH Adapter ── DSH profiles, Cordis plugins, Agents, tools
        ├── Paper / Knowledge Workers
        ├── Comparison Discovery / Repair / Reproduction Workers
        └── Experiment Scheduler ── isolated containers ── GPU workers
```

DSH 是 Agent Runtime 和插件宿主，不是科研数据库、GPU 调度器或唯一的长任务状态来源。业务层只依赖 `HarnessAdapter`，不直接依赖 DSH 内部实现。DSH 升级只需要通过适配层和兼容性测试。

## 分层与依赖方向

依赖只能从上到下通过公开 port/contract 进入，底层不能反向依赖 CLI 或具体 provider：

```text
Presentation       CLI/REPL/TUI、JSON、plain、attach
Application        commands/use-cases、Supervisor、审批、策略
Domain             Project/Run/Task/Idea/Comparison/Protocol/Experiment 状态和规则
Ports              TaskStore、ArtifactStore、EventBus、ModelGateway、Harness、Runner、CredentialBroker
Adapters           SQLite/Postgres、文件系统、DSH SDK、Python Worker、Docker/GPU、GitHub
Infrastructure     进程、网络、容器、日志、备份和操作系统
```

CLI command 不直接拼 SQL、不直接调用 DSH、不直接修改 artifact；它调用 Application use-case。Domain 规则不能依赖 Commander、SQLite、Node 进程 API、Python 或某个模型 provider。Adapters 可以依赖 Domain/Ports，反方向禁止。

新增模块先回答它属于哪一层，以及通过哪个 port 交互。若一个功能同时修改 CLI、数据库 schema、Agent prompt 和实验执行器，应拆成契约、应用编排和 adapter 三个可测试部分。

## 核心组合根

项目启动时由 composition root 组装：配置、DB、artifact store、event bus、DSH Harness、worker runner、experiment scheduler、credential broker 和 use-cases。业务模块通过接口接收依赖，不在函数内部隐式创建 SQLite、子进程或 DSH client；测试用 fake adapter 替换真实基础设施。

## 长任务边界

Supervisor 只负责领取/恢复 workflow node，不能把科研判断写进调度器。Agent/Worker 只返回结构化结果和 artifact 引用，不能直接推进下游阶段；Application 层依据 schema、门禁和 Decision/Event 推进状态。实验 runner 只执行已锁定的 ExperimentSpec，不修改 IdeaCard、协议或 comparison 状态。

## 当前实现成熟度

当前仓库已经有上述主要边界的实现雏形：`src/commands`、`src/workflow`、`src/dsh`、`src/worker`、`src/experiment`、`src/comparison`、`src/idea` 和 `src/knowledge`。Phase 5/6 继续开发时，必须逐步把 command 中的编排抽到 application/use-case 服务，避免每新增一个 CLI 命令就复制 DB、事件和门禁逻辑。这个重构是架构硬化，不应改变已锁定的数据契约。

## 进程

- **CLI**：初始化目录、配置、发出控制命令、订阅事件和显示报告。
- **Supervisor**：项目锁、run 生命周期、阶段状态、任务领取、checkpoint、恢复和事件发布。
- **DSH Runtime**：按 profile 启动 Agent；挂载角色工具和模型 provider。
- **Worker**：执行可重试的论文、comparison、知识和结果分析任务。
- **Experiment Scheduler**：根据实时 GPU/CPU/内存、资源请求和项目配额准入实验。
- **Artifact Store**：保存不可变文件、日志、代码快照、模型和报告，数据库只保存引用及元数据。
- **Workflow DB**：项目、输入快照、任务、对象版本、租约、事件和审计记录。

## DSH 插件边界

科研插件应使用公开的 Cordis plugin、bundle、Agent、Session、Tool、Subagent 和 profile 接口。每个插件声明配置 schema、依赖、启动和卸载行为。不要复制一套 Agent Loop，不要把长期任务状态只放在 DSH session 中。

推荐插件：

- `research-tools`：论文、知识库、Git、代码和实验工具注册；
- `research-agent-profiles`：角色 system prompt、模型路由和 capability profile；
- `research-events`：把 DSH Agent/Tool 事件映射为平台 RunEvent；
- `research-cli`：通过 headless/SDK 驱动 Supervisor；
- `research-approval`：高风险工具和人工确认门槛。

## 数据流

输入文件先做快照和哈希。解析产物、PaperCard、主题综合和 baseline 结果作为不可变 artifact 版本写入数据库引用。idea 只读取已确认知识和基线，代码写入独立 workspace。实验服务只读取指定数据版本和代码 commit，完成后写入 RunResult。任何下游对象都记录上游 ID 和版本，输入变化只使受影响节点失效。

## 模型层

首版直接使用 DSH 原生 provider，不引入 Pi。通过内部模型接口保留未来接入其他 provider、vLLM 或 OpenAI-compatible 服务的可能性；不把任何外部 Agent Runtime 与 DSH Agent Loop 叠加。请求记录 provider、model、prompt/schema 版本、token、成本、重试和错误。

## 可靠性

任务状态采用 `queued → leased → running → committing → succeeded/failed/canceled`；租约过期可重新入队。产物写入临时路径、哈希校验、原子 rename，再提交成功状态。实验有独立 run 和可选训练 checkpoint。事件持久化后再发送给客户端，客户端可以按序号回放。

## 安全边界

原始输入和 `upstream/` 只读；生成代码、第三方仓库和模型生成命令都在隔离容器中运行。模型 key、GitHub token 和 SSH 凭据由 credential broker/DSH credential store 处理，不进入 prompt、日志或容器。实验默认禁网，网络访问按工具和阶段单独授权。


