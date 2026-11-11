# IdeaSeek Full Research / Publication 模式

IdeaSeek 的默认模式是快速探索和 handoff。对于已经达到 `HANDOFF_READY`、用户明确认可的 idea，可以进入可选的 Full Research 模式：自动补齐公开数据、运行用户授权的全量实验、生成图表、执行结果/claim 审计，并交付论文草稿和复现包。

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

## 全量实验

Full Research 使用独立的 `full-run`，不污染探索 run：复用锁定协议、代码 commit、comparison 结果和 handoff manifest；支持多 GPU、长时间训练、训练内部 checkpoint、断点恢复和资源预算；保存完整命令、环境、数据 hash、随机种子、指标、日志、图表源数据和模型 artifact。全量实验失败进入 Result Analyst 和用户确认，不能自动改变论文主张。

## 图表与论文

ARIS-style workflow 可以生成主结果表、消融表、多种子/场景图、训练和资源曲线、失败分析、论文草稿、方法图、limitations 和 rebuttal 草稿。所有图表绑定 raw result、RunResult、代码/data/protocol hash；论文 claim 必须经过 result-to-claim、paper-claim-audit、citation audit 和独立 reviewer。论文草稿不等于已证明或可直接投稿。

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
