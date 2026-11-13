# IdeaSeek Full Research / Publication 模式

IdeaSeek 的科研闭环分为两个连续阶段：先在 smoke/quick/standard 切片上高效探索并生成可审查的 `HANDOFF_READY` 候选；研究者认可后，再通过明确授权进入全量研究与论文交付。全量阶段不是快速探索的默认动作，但它是 IdeaSeek 最终产品能力的一部分，不是无关的可选插件。完整链路为：

`Idea discovery → 小规模验证/反馈迭代 → HANDOFF_READY + researcher approval → 全量 comparison/idea 实验 → 统计与图表 → claim/citation/integrity audit → Overleaf 兼容论文工程与复现包`

## 进入条件

Full Research 不能由 Agent 自己开启，必须满足：

- Idea 已达到 `HANDOFF_READY`；
- required comparison 已通过；
- quick/standard、多种子、关键消融和场景门槛通过；
- 用户明确确认研究问题、数据用途、预算、最长运行时间、网络和许可证策略；
- 当前机器/队列能够承受预计资源，或用户指定外部运行环境；
- 用户确认论文输出是草稿/研究辅助产物，最终科学结论由研究者审阅。

## 数据集获取

Dataset Discovery Agent 可以从论文、代码 README 和允许的学术索引发现候选数据集，但下载前必须展示来源、版本、许可证、访问限制、大小、预计成本、数据外发策略、校验 hash 和缓存位置。用户可以批准公开数据下载，也可以自己下载并放入 `datasets/`。私有、需申请、受限制或许可证不清的数据不能自动下载；下载失败进入 `DATA_ACCESS_REQUIRED`。

## 全量 comparison 清单与实现来源

IdeaSeek 不能让用户凭经验手工猜全量论文该比较哪些方法。进入 Full Research 前，Comparison Planner 综合研究问题、PaperCard/研究地图、近期相关工作、目标 venue/子领域、用户提供的 comparison、数据集与社区 benchmark protocol，提出可审查的 comparison matrix。目标 venue（例如用户指定的 CCF A/B 会议或期刊）是规划上下文，不是录用保证；venue 要求和近期论文证据必须带来源与时间，用户确认最终清单。

每个候选方法标为 `required`、`reference-only`、`excluded` 或 `blocked`，并记录纳入理由、来源论文及定位、官方/作者代码候选、实现身份、许可证、协议适配差异、数据/指标、算力和失败/不可复现风险。清单至少检查代表性经典基线、近期强基线、直接最近邻方法、同类方法和适用的公开 benchmark；不相关或无法公平比较的方法必须给出理由，不能机械复现论文库中的所有方法。只有用户确认的 required 项进入全量比较门禁。平台侧命令 `ideaseek comparison matrix [--confirm]` 从已持久化证据（注册方法、PaperCard 最近邻、语料卡片数、存稿 venue）生成可编辑清单；`--confirm` 把（可能被用户编辑过的）分类应用到注册表——required 标记驱动门禁、excluded/blocked 走状态机并以纳入理由作 reason，paper-card 候选只列出、绝不自动注册。近期文献与 venue 推理的 agent 增强依赖模型凭据，属后续切片。

实现来源顺序：官方/作者仓库可用时，核验论文与仓库关联、commit/release、许可证、数据/入口和配置；隔离 clone，先修环境、smoke 和小切片，再锁定复现版本。没有可用代码时才按论文重实现，并记录假设、缺失细节、实现差异和置信度，标为 `paper-reimplementation — NOT official code`。关键细节不足时标为 blocked/request-details，不伪造论文细节或结果。

锁定前逐方法对齐数据版本与 split、预处理、训练/验证/测试用途、主/次指标、模型选择规则、调参预算、随机种子/重复次数、早停规则和计算资源。文献原报告与本地复现结果分开呈现；无法统一的条件显式记录 deviation 并交研究者确认。`ideaseek full fairness --idea <id>` 把该对齐固化为可复核的 fairness lock：可机检维度（data/split、指标、seeds）从记录的 spec 自动比对，平台无法机检的维度（预处理、调参预算、早停、模型选择、资源）明标为 declared、由研究者 `--confirm` 声明；缺协议锁、缺 idea spec、required 方法无成功实验都是带恢复命令的 blocker。`full plan` 要求该锁已确认且随状态变化自动失效。

## 全量实验

Full Research 使用独立的 `full-run`，不污染探索 run。它要在锁定协议和数据/代码快照下，执行所有 required comparison 与最终 idea 实现的全量实验；用户确认基线版本、数据与 split、指标、种子/重复次数、预算、时限、资源与停止规则后才启动。支持多 GPU、长时间训练、训练内部 checkpoint、断点恢复和资源预算；保存完整命令、环境、数据 hash、随机种子、指标、日志、原始预测/逐轮指标等可用中间结果、图表源数据和模型 artifact。全量实验失败进入 Result Analyst 和用户确认，不能自动改变论文主张。Quick/standard 结果不能冒充全量结果，探索期 idea 代码变更也不能静默污染已锁定 full-run。

## 图表与论文

优先复用 ARIS 的 `paper-plan → paper-figure → paper-write → paper-compile` workflow。ARIS `paper-figure` 已覆盖常见的数据驱动图：训练/收敛折线图、方法对比柱状图、散点图、热图、箱线图/小提琴图、多面板图，以及 LaTeX 比较表；图形应从全量实验记录与锁定统计定义生成。方法/系统架构图可通过 ARIS figure-spec / method-figure 等专用流程生成或给出可编辑骨架。

图表能力按来源分级，不宣称自动生成任意视觉内容：

- **自动生成**：有结构化数据支撑的指标对比、消融、多种子分布、训练曲线、资源/时间曲线、超参敏感性、跨数据集/场景结果和统计表。是否生成某类图，取决于协议和实际记录的数据；缺少记录时不得编造。
- **需要额外输入或专用生成器**：方法架构/流程图、定性样例、图像/视频结果拼图、案例可视化、注意力/分割叠加图等。这些需要模型输出、样例、空间/时间中间值，或通过 figure-spec / image workflow 生成，并经用户或 reviewer 检查。
- **人工补充或确认**：无法从机器记录重建的视觉案例、领域特定示意图、授权受限图片和存在歧义的科学解释。平台必须在 figure plan 标出 `manual/input-required`，不能用装饰图替代证据图。

IdeaSeek 必须为每个 figure/table 保存类型、问题/claim、数据源与过滤、统计聚合/误差条定义、绘图代码/模板版本、生成环境、输入 hash、输出 hash、caption 和审阅状态；相同锁定输入应能重建图表。导出矢量格式（PDF/SVG）和适合预览的 PNG；每个图都要检查数据、标签、单位、色盲/灰度可读性和 caption 一致性。论文 claim 必须经过 result-to-claim、paper-claim-audit、citation audit 和独立 reviewer。论文草稿不等于已证明或可直接投稿。

论文交付以 Overleaf 兼容的 LaTeX 工程为主，同时保留 Markdown/JSON 中间 artifact：

```text
paper/
  main.tex
  sections/
    introduction.tex
    related_work.tex
    method.tex
    experiments.tex
    limitations.tex
  figures/
  tables/
  references.bib
  assets/
  results/              # 图表源数据和生成 manifest
  provenance.json
  README.md             # 本地编译和 Overleaf 上传说明
  environment.lock
```

平台生成一个可上传到 Overleaf 的 zip/目录，不要求用户安装完整 LaTeX 才能拿到结果。用户可以把整个 `paper/` 上传到 Overleaf，也可以只复制 `.tex`、`figures/`、`tables/` 和 `.bib`。源 Markdown/JSON、实验结果和 provenance 保留在 IdeaSeek 项目中，LaTeX 是可编辑交付物，不是不可追溯的最终黑盒。

## CLI

```bash
ideaseek full fairness --idea <idea-id>
ideaseek full fairness --idea <idea-id> --confirm
ideaseek full plan --idea <idea-id>
ideaseek full approve --idea <idea-id> --confirm
ideaseek full data discover --idea <idea-id>
ideaseek full data download --candidate <dataset-id> --confirm
ideaseek full run --idea <idea-id> --detach
ideaseek full attach --run <full-run-id>
ideaseek full paper --run <full-run-id>
ideaseek full audit --run <full-run-id>
ideaseek paper export --run <full-run-id> --format overleaf --out paper.zip
```

用户可以暂停下载、训练、绘图或论文生成；已完成 artifact 保留。最终交付包括论文草稿、图表源数据、代码 commit、环境锁文件、数据来源/许可证、全量日志、审计报告和未解决风险。
