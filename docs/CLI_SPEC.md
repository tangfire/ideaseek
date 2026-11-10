# CLI 规范

CLI 名称为 `ideaseek`，每条命令默认在当前目录寻找 `.research/`。命令必须支持 `--json` 机器可读输出和 `--run <run_id>`。

## 生命周期命令

```bash
ideaseek init
ideaseek start --question "..."
ideaseek setup
ideaseek doctor
ideaseek scan
ideaseek organize [--apply]
ideaseek intake
ideaseek config explain
ideaseek confirm protocol
ideaseek next
ideaseek run --question "..."
ideaseek run --question "..." --ideas 3
ideaseek run --question "..." --detach
ideaseek attach --run <id>
ideaseek watch --run <id>
ideaseek status --detail
ideaseek events --run <id> --since <seq>
ideaseek pause [--hard]
ideaseek resume [--run <id>]
ideaseek cancel --run <id>
ideaseek continue --run <id>
ideaseek data describe
ideaseek data slices
ideaseek experiment promote --idea <id> --to standard
ideaseek experiment handoff --idea <id>
ideaseek report [--run <id>]
```

`init` 创建目录和模板，不覆盖已有文件；`start` 是小白用户的一键入口，组合轻量检测、扫描、协议草案和受限运行；`setup` 优先自动检测并只询问无法安全推断的配置；`doctor` 只做检查；`scan` 递归发现用户随手放入的论文、代码、数据和压缩包；`organize` 预览或应用对象归类，但不移动/覆盖原始文件；`config explain` 显示生效配置来源；`confirm protocol` 确认平台提出的实验协议；`next` 只给建议，不启动高成本工作；`run` 创建或恢复工作流；`attach/watch` 订阅实时事件；`pause/resume/cancel` 是可审计的控制操作。

交互提示符、启动 banner、事件摘要、审批块和 plain/JSON 显示模式遵循 [TERMINAL_UX.md](TERMINAL_UX.md)。CLI UI 只显示状态和动作摘要，不显示模型隐藏推理。

`scan` 默认扫描 `papers/`、`datasets/`、`comparisons/` 和 `incoming/`，产生 `knowledge/input-manifest.json` 和 `knowledge/input-review.md`；不会扫描 `.research/`、`ideas/`、日志或实验产物。`intake` 展示待分类对象和候选关联。默认只建立索引和关联，不复制、不移动、不删除用户文件。`organize --apply` 仅创建平台管理的软链接或副本，所有来源路径和哈希都记录。检测到歧义时要求用户确认，不把目录名猜成科学事实。

如果运行因 token/API 额度、GitHub 限额或 provider 余额暂停，状态为 `QUOTA_EXHAUSTED` 或 `AUTH_REQUIRED`。用户补充额度/凭据后执行 `ideaseek doctor`，再执行 `ideaseek continue`；它从最近 checkpoint 继续，不重做已经成功的任务。

`--ideas N` 指定本次最多进入实现和实验验证的候选数量。省略时由平台按候选差异度、证据完整度、资源/预算和预计信息增益决定，默认先验证 1 个；它不是“强行生成 N 个 idea”。新增论文、数据集或 comparison 时，run 只补做受影响的对象，复用未变化的 PaperCard、baseline 和实验 artifact。

实验默认使用 `quick` 数据规模；可用 `--data-scale smoke|quick|standard` 覆盖。Idea 先在低成本规模做区分性实验，通过预设门槛后才晋级。`experiment handoff` 生成用户自行运行全量实验所需的代码、split、配置、环境和命令，但 IdeaSeek 不执行全量训练。数据切片和预处理都有 manifest/hash，可通过 `data describe/slices` 查看。

## 实时事件

事件显示阶段、角色、对象 ID、动作摘要、状态、资源和错误。例如：

```text
[#183] PAPER_ANALYSIS  PaperExtractor paper=paper-042  completed  42/1000
[#184] BASELINE_REPAIR method=method-b  failed  ModuleNotFoundError
[#185] GPU_QUEUE       idea=idea-002  waiting  requested=1 GPU, 8 GiB
```

不显示模型隐藏思维链、secret 或无限原始日志。详细日志通过 `ideaseek logs --task <id>` 查看并做敏感信息脱敏。

## `next` 示例

```text
当前阶段：BASELINE_REPAIR
阻塞：comparisons/method-b 有 2 个 required 检查失败
已完成：论文 1000/1000；数据集检查；method-a 复现
建议：继续有限修复，或检查日志后提供缺失依赖
下一条命令：ideaseek baseline repair --method method-b
```

## 退出码

- `0`：命令完成，或 watch 观察到正常完成；
- `1`：任务失败或不可恢复错误；
- `2`：用户输入/配置/凭据缺失；
- `3`：当前仍在运行或等待资源；
- `4`：用户主动取消；
- `5`：环境不支持（容器、Python、CUDA 等）。

## 后台约束

同一项目默认只允许一个活动 run。后台 supervisor 保存 PID、版本、心跳和日志；SSH 断开不影响运行。第二个 run 必须显式使用独立 workspace 或用户确认。


