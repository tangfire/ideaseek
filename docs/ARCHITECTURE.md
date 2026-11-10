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


