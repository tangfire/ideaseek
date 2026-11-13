# IdeaSeek 用户指南

IdeaSeek 是一个领域无关的科研探索多 Agent CLI。你提供研究问题、该方向论文、已有数据和可选的 comparison；它从这些材料中学习实验设计，生成当前项目的实验协议，复现/修复 comparison，提出和验证多个 idea，并交付值得继续做全量实验的代码和 handoff。

IdeaSeek 的探索实验使用 `smoke`、`quick` 和 `standard` 数据规模。最终全量训练由研究者拿到 handoff 后自行运行。

## 5 分钟开始

### 安装

正式发布后的目标安装方式：

```bash
npm install -g ideaseek
ideaseek doctor
```

当前源码开发版本请先阅读 [PACKAGING.md](PACKAGING.md) 和 [BOOTSTRAP_DEVELOPMENT.md](BOOTSTRAP_DEVELOPMENT.md)。

### 创建研究项目

```bash
mkdir fl-model-heterogeneity
cd fl-model-heterogeneity
ideaseek init
```

当前目录就是项目。IdeaSeek 会创建：

```text
papers/       # 研究论文
datasets/     # 用户数据集或只读挂载
comparisons/  # 对比方法论文/代码
idea-seeds/   # 用户已有 idea/代码/结果，可为空
incoming/     # 暂时不确定类型的材料
knowledge/    # 论文卡片、研究地图、协议和 baseline 记录
ideas/        # 每个 idea 的独立代码和实验
reports/      # 中间和最终报告
.research/    # 数据库、任务、缓存和 checkpoint
```

### 配置并检查环境

```bash
ideaseek setup
ideaseek doctor
```

IdeaSeek 会检测 Node、Python、容器、CUDA、GPU、磁盘、DSH provider 和可选本地 embedding。当前 `/models` 用于查看模型 route/凭据状态和切换项目 route；API key 需通过 DSH credential store、系统 secret manager 或已配置的环境变量提供。不要把 key 写入项目文件。交互式 key 配置向导尚未提供。

### 放入输入

把论文、数据、comparison 代码或已有 idea 的文件夹/压缩包放入 `papers/`、`datasets/`、`comparisons/` 或 `incoming/`。不确定的材料先放 `incoming/`，然后运行：

```bash
ideaseek scan
ideaseek intake
ideaseek plan --question "在联邦学习中，不同客户端模型结构不一致时，如何实现有效知识协作？"
```

`scan` 只建立 manifest 和候选分组，不移动或覆盖原始文件。`plan` 显示论文数量、数据、comparison、模型 route、预计 token/GPU/磁盘和需要确认的科学语义。

### 启动探索

```bash
ideaseek start --question "在联邦学习中，不同客户端模型结构不一致时，如何实现有效知识协作？"
```

限制本次最多进入实验的 idea 数量：

```bash
ideaseek run --question "..." --ideas 3 --data-scale quick
```

默认模式是 `guided`：论文解析、检索、代码检查和 quick 实验自动执行；研究问题、数据语义、协议锁定、comparison 清单和 handoff 等关键节点会请求确认。

## 运行中查看和控制

前台运行时可以直接观察事件，也可以后台运行：

```bash
ideaseek run --question "..." --detach
ideaseek attach --run <run-id>
ideaseek status --detail
ideaseek next
ideaseek pause --run <run-id>
ideaseek resume --run <run-id>
ideaseek continue --run <run-id>
```

进入交互终端：

```bash
ideaseek interactive
```

常用命令：

```text
/models       查看模型 route/provider
/status       查看阶段、任务、资源和预算
/next         查看阻塞和下一步
/papers       查看论文进度和解析失败
/comparisons  查看 comparison 状态
/ideas        查看 idea 和版本
/experiments  查看实验队列和结果
/logs <id>    查看脱敏日志
/approve      确认当前协议或门槛
/pause        安全暂停
/resume       恢复
/report       生成报告
/quit         退出交互界面，不取消后台任务
```

交互提示符也接受自然语言，例如“为什么 method-b 还没通过？”或“优先验证 idea-002”。高影响操作会变成待确认 Decision。当前 Agent 模式切换只改变会话模式与权限摘要；持续对话的通用编码 Agent 尚未完成。

## IdeaSeek 会做什么

流程通常是：

```text
论文并行阅读
→ PaperCard 和证据
→ 研究地图和机制库
→ 数据画像和实验协议
→ comparison 发现/复现/修复
→ 多个 idea 生成
→ 独立代码和 quick/standard 实验
→ 消融和 Result Analyst
→ idea 修订或新 idea 分支
→ handoff 代码和全量实验配置
```

IdeaSeek 不把“方法 A + 方法 B”直接当成创新。候选需要有问题矛盾、机制链、最近邻工作、可观测预测和否证条件。

## 查看结果

```bash
ideaseek report
ideaseek idea list
ideaseek idea analyze --idea <idea-id>
ideaseek experiment handoff --idea <idea-id>
```

每个 idea 位于 `ideas/<idea-id>/`，包含说明、代码、数据切片、实验、消融和复现命令。结果等级包括：

- `EXPLORATORY`：初步机制证据；
- `PROMISING`：quick/部分 standard 验证支持；
- `HANDOFF_READY`：达到跨场景、复现和资源门槛；
- `USER_FULL_RESULT`：研究者自行完成全量实验后的结果。

`HANDOFF_READY` 表示值得投入全量实验，不代表 IdeaSeek 已证明全量结果一定有效。

Full Research 的论文交付默认是 Overleaf 兼容的 LaTeX 工程：

```bash
ideaseek paper export --run <full-run-id> --format overleaf --out paper.zip
```

把 `paper.zip` 上传到 Overleaf 即可继续编辑；工程包含 `main.tex`、章节、图表、BibTeX、编译说明、结果源数据和 provenance。IdeaSeek 也保留 Markdown/JSON 版本，方便审计和重新生成图表。

## 改进已有 Idea

如果你已经有 idea、代码和部分实验结果，把它的文件夹放进当前项目：

```bash
idea-seeds/my-existing-idea/
  README.md
  idea.md
  code/
  results/
```

然后执行：

```bash
ideaseek scan
ideaseek intake
ideaseek idea improve --source idea-seeds/my-existing-idea --question "为什么当前方法在跨客户端泛化上不足？"
```

IdeaSeek 会先复现原始 baseline，再分析代码、论文、数据、comparison、错误分布和新颖性风险，然后提出多个改进路线。原始代码保持只读；工程修复生成同一 idea 的新版本，科学假设变化创建新的 idea 分支。每条改进路线都要经过 quick/standard 实验和消融，不能把没有复现原始 baseline 的结果写成改进有效。

## 补充论文、数据或 comparison

把新增材料放入项目后再次运行：

```bash
ideaseek scan
ideaseek run --question "..."
```

IdeaSeek 按内容 hash 和版本增量处理：新增论文只触发受影响的 PaperCard/综合；新增数据只触发相关 snapshot、comparison 和实验；新增 comparison 只补做该方法。

如果用户暂时没有某些数据，IdeaSeek 可以根据论文、数据集论文和代码 README 发现候选数据集：

```bash
ideaseek datasets discover --question "..."
ideaseek datasets list
ideaseek datasets explain <candidate-id>
ideaseek datasets authorize <candidate-id> --grant --confirm --reason "..."
ideaseek datasets link <candidate-id> --path datasets/<file>
```

结果包含用途、字段、规模、许可证、来源论文、获取方式和推荐理由。平台默认只推荐，不自动下载大型或受限数据；大型、受限或获取方式不明的数据集必须显式确认（`datasets authorize --grant --confirm`）。用户自行下载或授权挂载数据后，先运行 `scan`，再用 `datasets link` 把数据绑定到候选——只有绑定后候选才进入 `user-provided`/`validated` 并可用于实验。

## 在同一项目继续思考新的 idea

如果几天后论文、数据和 comparison 都没有变化，不要重新初始化项目。创建新的 ideation round：

```bash
ideaseek ideate --round new --ideas 3
ideaseek rounds list
ideaseek rounds show <round-id>
```

新 round 会复用已经完成的论文知识、协议、baseline 和实验结果，读取上一轮的 idea、失败原因和用户反馈，并要求新候选与上一轮有明确差异。没有新的证据或机制时，平台可以诚实返回没有足够新信息，而不是重复生成相同 idea。

## 出错、额度耗尽和恢复

```bash
ideaseek doctor
ideaseek status --detail
ideaseek next
ideaseek continue --run <run-id>
```

模型额度、GitHub 限额或 provider 余额耗尽会进入可恢复状态。已完成论文、comparison、idea 和实验不会重做。GPU OOM、进程崩溃、SSH 断开和服务器重启也从最小 checkpoint 继续。

## 项目和历史记录

当前目录默认是当前项目：

```bash
ideaseek status
ideaseek projects
ideaseek open ~/research/another-project
ideaseek status --project ~/research/another-project
```

## 进一步阅读

- [CLI_SPEC.md](CLI_SPEC.md)：完整命令和退出码；
- [TERMINAL_UX.md](TERMINAL_UX.md)：终端交互和事件显示；
- [MODEL_ROUTING.md](MODEL_ROUTING.md)：模型分层和 `/models`；
- [USER_JOURNEY_ACCEPTANCE.md](USER_JOURNEY_ACCEPTANCE.md)：完整用户旅程验收；
- [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md)：专业产品要求；
- [OPERATIONS.md](OPERATIONS.md)：部署、凭据、备份和故障处理。
