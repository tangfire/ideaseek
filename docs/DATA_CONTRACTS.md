# 数据与 artifact 契约

数据库是权威状态；项目目录中的 Markdown/JSON 是可读导出。所有对象有稳定 ID、版本、创建时间、来源和内容哈希。不可变版本不得原地覆盖。

## PaperCard

```json
{
  "paper_id": "paper-042",
  "document_hash": "sha256:...",
  "title": "...",
  "problem": "...",
  "method": {"summary": "...", "steps": [], "motivation": []},
  "datasets": [],
  "metrics": [],
  "baselines": [],
  "limitations": [],
  "claims": [{"text": "...", "evidence": [{"page": 5, "section": "Experiments"}]}],
  "unknowns": [],
  "parser_version": "...",
  "prompt_schema_version": "..."
}
```

无法从原文确认的字段使用 `unknown` 或 `uncertain`，不能编造。

## InputManifest / CandidateGroup

`InputManifest` 记录原始路径、文件类型、大小、内容 hash、发现时间、解析器版本和候选角色。`CandidateGroup` 记录可能属于同一论文、comparison 或 dataset 的文件、置信度、识别依据和待用户确认字段。manifest 是增量处理的依据；原始路径不能被整理动作覆盖。

## ArchiveInput

压缩包是合法的一等输入。记录原始 archive path/hash/size/format、解压 artifact、成员清单、成员 hash、来源关系、解析器版本、阻塞项和安全扫描结果。原压缩包只读；解压目录是平台管理的不可变输入快照或隔离 worktree。

## RepositoryUnderstanding

记录用户仓库的任意结构分析结果：source snapshot/hash、语言、依赖清单、候选训练/评估/测试入口、配置文件、数据加载/输出接口、指标实现、README 说明、识别证据、置信度、未解决问题和用户确认。入口和命令不能只凭常见文件名猜定；自动运行前先在隔离副本做静态检查和 smoke test。

## DatasetCandidate

必须包含名称、来源 URL/索引 ID、相关论文、任务/字段说明、规模、许可证/访问限制、发现时间、查询/证据、与当前研究问题的关联理由、置信度和状态（`recommended`/`needs-access`/`user-provided`/`validated`/`rejected`）。推荐不等于已下载或已验证；只有用户提供/授权并建立 DatasetSnapshot 后才能进入实验。

## ComparisonMethod

必须包含 `method_id`、论文引用、`required`、代码来源（`user`/`official-code`/`paper-reimplementation`）、来源 URL/commit、许可证、入口、依赖、数据接口、指标、patch hash、复现置信度和状态。原始仓库、修复 worktree 和论文重实现不能混为一个路径。

## ExperimentalProtocolProposal

必须包含任务定义、样本单位、字段/标签解释、切分 manifest 规则、泄漏检查、预处理、baseline 入口、主/辅指标、统计汇总、smoke test、资源估算、消融模板、支持/否证/无效判据、停止条件，以及每项规则的来源（论文证据、代码、数据探测、适配器规则或 Agent 推断）和置信度。用户确认后生成锁定的协议版本；变更协议会使受影响的 comparison/idea 任务产生新版本。

## DatasetSlice

必须包含 `dataset_snapshot_id`、`scale`（`smoke`/`quick`/`standard`）或 `handoff_manifest`、选择规则、输入/输出 hash、统计摘要、随机种子、主体/客户端/域边界、生成代码版本和适用限制。探索切片是可重建派生 artifact，不能覆盖原始数据；实验结果必须引用具体 slice ID。`handoff_manifest` 只描述用户后续自行运行的全量实验，不代表 IdeaSeek 已执行。

## RunEnv

comparison 的 `reproduce.py` 和 idea 的 `train.py` 等入口命令不接收命令行里的数据路径，而是从环境变量读取位置：`IDEASEEK_PROJECT_ROOT`（项目根绝对路径）和 `IDEASEEK_DATASET_ROOTS`（`inputs.readonly_datasets` 按平台路径分隔符连接，未配置时不注入）。这两个变量由 `src/experiment/run-env.ts` 在每次 spawn 前从项目配置解析，method-local venv 的变量优先于注入值。

入口脚本必须据此解析数据位置，不得把某台机器的绝对路径写进源码：同一份 comparison 或 idea 代码要在 Windows 开发机、WSL2 和 Linux 服务器上跑通，写死路径会让 Phase 6 的领域无关验收和服务器 full-run 直接失效。缺少变量时脚本应明确报错并提示配置 `inputs.readonly_datasets`，而不是回退到某个默认路径。

`ideaseek idea scaffold` 生成的骨架自带 `src/dataset_ref.py`：`config/train.json` 的 `dataset_ref` 指向只读根下的相对路径（也允许配置成本机绝对路径），未配置时仍走骨架自带的 `data/synthetic.csv`。Code Implementer 写真实实现时必须通过该 helper 取数据，不得自行拼接路径。

## IdeaCard

必须包含研究假设、目标、论文证据、问题矛盾、机制链、最近邻 comparison、差异主张、组件必要性、竞争解释、风险、最小区分性实验、消融、主指标、否证条件、预算和停止条件。idea 版本变化要有 `parent_version`；科学假设变化要新建 `idea_id`。缺少机制解释、只是已有模块的表面组合时，状态必须为 `DRAFT_COMPOSITION`，不能进入自动实验队列。

## ExperimentSpec / RunResult

`ExperimentSpec` 包含 idea/version、comparison IDs、代码 commit、数据 snapshot、切分 manifest、环境镜像、命令、指标、种子、资源请求和预算。`RunResult` 包含状态、日志/artifact 引用、指标、方差、资源实际消耗、失败类别、开始/结束时间和解释。

## RunEvent

事件包含单调 `seq`、`run_id`、时间、阶段、对象 ID、角色、事件类型、公开摘要、状态和 artifact 引用。secret、完整 prompt 和模型隐藏推理不进入事件流；详细原始日志有独立权限和脱敏。

## 版本与失效

输入文件、解析器、prompt/schema、模型、代码、环境、数据切分任何一个变化都会产生新版本。缓存键必须包含所有相关版本。输入变化只使依赖图上的下游节点失效；旧 run 仍可审计和报告。


