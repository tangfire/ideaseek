# IdeaSeek 配置契约

配置文件为项目根目录的 `research.yaml`。配置是用户意图和资源边界，不保存 secret。平台读取后生成带版本的 `ResolvedConfig`，每个 run 固定一份解析后的配置快照。

## 最小配置

```yaml
project:
  name: continual-learning
  domain: continual-learning
research:
  question: "如何降低持续学习中的灾难性遗忘？"
  mode: auto
  autonomy: guided
  idea_limit: 1
  external_search: false
inputs:
  papers_dir: papers
  datasets_dir: datasets
  comparisons_dir: comparisons
runtime:
  profile: headless
  model_route: default
  container_runtime: docker
  allow_network: false
  default_data_scale: quick
models:
  routes:
    fast: default-fast
    balanced: default-balanced
    deep: default-deep
resources:
  max_parallel_agents: 8
  max_parallel_ideas: 2
  max_gpu_hours: 20
  max_model_cost: 50
  max_iteration_rounds: 3
policy:
  require_all_comparisons: true
  require_user_confirmation_before_experiments: true
  allow_paper_reimplementation: true
  auto_accept_discovered_comparisons: false
```

## 配置规则

- 配置采用“自动检测优先、显式覆盖其次、无法安全推断才询问”的顺序。Python、Node、容器、CUDA、GPU、CPU、内存、磁盘、默认模型 endpoint、公开 GitHub 访问和项目输入路径尽量由 `setup/doctor/scan` 自动发现。
- 平台不得从文件夹名称推断研究问题、标签含义、comparison 是否 required 或数据集 split；这些属于需要用户确认的语义配置。
- 未提供 `idea_limit` 时使用平台决策：默认先验证 1 个候选；命令行 `--ideas N` 只影响当前 run。
- `research.mode: auto` 根据论文/数据/comparison 规模选择 `starter`、`standard` 或 `research`；用户可显式指定，但平台仍显示证据和资源限制。
- `research.autonomy` 可选 `guided`（默认）、`autonomous` 或 `review-only`；无人值守必须显式配置，不能由 Agent 自行切换。
- 模型路由可按 role 覆盖，但所有 route 必须在 DSH provider/profile 中可用；高成本 `deep` route 受项目 token/费用预算约束，路由变更会记录到 run snapshot。
- `runtime.default_data_scale` 默认是 `quick`，探索阶段可选 `smoke`/`quick`/`standard`；只有达到 `HANDOFF_READY` 并完成明确审批后，Full Research 才可执行独立 full-run。详细授权、资源和恢复契约见 `FULL_RESEARCH_MODE.md`。每个探索规模的样本、步数、客户端/场景和 GPU 预算都要可配置。
- `max_parallel_ideas` 不得超过实际资源和 scheduler 安全上限；资源不足时排队。
- `external_search`、`allow_network`、第三方模型外发和 GitHub 私有仓库访问分别控制，不互相隐含授权。
- 联网/内网/离线能力及阻塞语义见 [OFFLINE_MODE.md](OFFLINE_MODE.md)：云 provider 无法访问时暂停依赖模型的任务；离线发现只报告本地语料覆盖范围，不声称外部文献已穷尽。
- 额度/凭据策略有独立的暂停与恢复语义：token、余额或限额耗尽时暂停新模型任务；补充凭据后允许继续，不把失败任务标记为科学失败。
- `require_all_comparisons: true` 时，所有 `required: true` 的方法必须通过 comparison 门槛。
- 修改输入目录、模型、解析器、prompt/schema、环境或实验策略时创建新 run 或配置版本；旧 run 保持可审计。
- 配置 schema 有 `config_version`。不兼容变更由迁移器处理，迁移前备份原文件并展示 diff；无法安全迁移时停止而不是猜测默认值。

## 配置检查

`ideaseek doctor` 必须检查字段类型、路径、预算是否为正值、策略冲突、模型端点、凭据引用、容器和 GPU 能力。未知字段默认警告并拒绝运行，避免拼写错误悄悄变成默认配置。`ideaseek config explain` 输出每个生效字段的来源：默认、文件、环境变量还是命令行。

