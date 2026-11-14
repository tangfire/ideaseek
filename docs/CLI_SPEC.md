# CLI 规范

CLI 名称为 `ideaseek`，每条命令默认在当前目录寻找 `.research/`。命令必须支持 `--json` 机器可读输出和 `--run <run_id>`。

## 生命周期命令

```bash
ideaseek init
ideaseek start --question "..."
ideaseek setup
ideaseek doctor
ideaseek models
ideaseek models list
ideaseek models providers
ideaseek models test --route deep
ideaseek interactive --mode research
ideaseek agent "把预处理里的日期列修对" --resume <sessionId>
ideaseek mode
ideaseek plan --question "..."
ideaseek projects
ideaseek open <project-path>
ideaseek scan
ideaseek organize [--apply]
ideaseek intake
ideaseek config explain
ideaseek confirm protocol
ideaseek next
ideaseek run --question "..."
ideaseek run --question "..." --ideas 3
ideaseek ideate --round new --ideas 3
ideaseek idea import <incoming-path>
ideaseek idea improve --source incoming/ideas/<name> --question "..."
ideaseek idea improve --idea <idea-id> --ideas 3
ideaseek rounds list
ideaseek rounds show <round-id>
ideaseek feedback --idea <idea-id> --label useful
ideaseek run --question "..." --detach
ideaseek attach --run <id>
ideaseek watch --run <id>
ideaseek status --detail
ideaseek explain <task|decision|artifact>
ideaseek cleanup --dry-run
ideaseek archive --run <id>
ideaseek export --run <id> --to <path>
ideaseek events --run <id> --since <seq>
ideaseek pause [--hard]
ideaseek resume [--run <id>]
ideaseek cancel --run <id>
ideaseek continue --run <id>
ideaseek data describe
ideaseek data slices
ideaseek datasets discover --question "..."
ideaseek datasets list
ideaseek datasets explain <candidate-id>
ideaseek datasets authorize <candidate-id> --grant|--deny --reason "..." [--confirm]
ideaseek datasets acquire <candidate-id> [--max-gib 50] [--timeout-ms 120000] [--confirm]
ideaseek datasets link <candidate-id> --path <file>
ideaseek experiment promote --idea <id> --to standard
ideaseek experiment handoff --idea <id>
ideaseek paper export --run <id> --format overleaf --out <path>
ideaseek report [--run <id>]
```

`init` 创建目录和模板，不覆盖已有文件；`start` 是小白用户的一键入口，组合轻量检测、扫描、协议草案和受限运行；`setup` 优先自动检测并只询问无法安全推断的配置；`doctor` 只做检查；`scan` 递归发现用户随手放入的论文、代码、数据和压缩包；`organize` 预览或应用对象归类，但不移动/覆盖原始文件；`config explain` 显示生效配置来源；`confirm protocol` 确认平台提出的实验协议；`next` 只给建议，不启动高成本工作；`run` 创建或恢复工作流；`attach/watch` 订阅实时事件；`pause/resume/cancel` 是可审计的控制操作。

交互提示符、启动 banner、事件摘要、审批块和 plain/JSON 显示模式遵循 [TERMINAL_UX.md](TERMINAL_UX.md)。CLI UI 只显示状态和动作摘要，不显示模型隐藏推理。`research` 是默认模式；`agent` 复用 DSH 做受限项目代码/日志/测试协助。

交互提示符同时接受 slash 命令和自然语言。自然语言只被转换成查询、建议或待审批 Decision；不能直接绕过状态机、预算、权限或数据快照。高影响请求显示变更摘要和确认选项。

模型配置同时支持交互和脚本：`/models` 或 `ideaseek models` 查看 route/provider/model 状态；`models providers` 列出可配置的 provider（内置已知端点 + DSH settings 中已有条目，只输出名称和端点）；`models test` 只做最小连接和能力检查。TUI 里 `/models setup` 是分步的：不带 provider 时先列目录并回 `选择：/models setup <编号或 id>`，选定后才进入隐藏 key 输入；不在目录内的 id 必须显式给 `--base-url`。连接测试失败会说明 key 来自隐藏输入还是环境变量、以及它的字符长度（不输出任何 key 内容），用于区分"key 错"和"粘贴被截断"。API key 使用隐藏输入，写入 DSH credential store 或外部 secret manager，不写入 `research.yaml`、prompt、事件、日志或 git。`--json` 输出只包含脱敏 provider、model、route、能力和额度状态。

`scan` 默认扫描 `papers/`、`datasets/`、`comparisons/`、`idea-seeds/` 和 `incoming/`，产生 `knowledge/input-manifest.json` 和 `knowledge/input-review.md`；不会扫描 `.research/`、平台管理的 `ideas/`、日志或实验产物。`intake` 展示待分类对象和候选关联。代码仓库允许任意目录结构；Codebase Analyst 通过 README、依赖、测试和源码检查生成候选入口/数据接口说明，不要求用户改成固定模板。自动识别必须给出依据和置信度；有歧义时先确认，再在隔离副本中 smoke test。默认只建立索引和关联，不复制、不移动、不删除用户文件。`organize --apply` 仅创建平台管理的软链接或副本，所有来源路径和哈希都记录。检测到歧义时要求用户确认，不把目录名猜成科学事实。

`scan/intake` 支持常见压缩包。平台先列出 archive 成员和候选类型，再在隔离目录安全解压；拒绝绝对路径、`../` 穿越、危险 symlink、过深嵌套、压缩炸弹、超出大小/文件数配额或需要密码的 archive。原压缩包不执行、不覆盖、不删除；未知、损坏或加密格式进入 `ARCHIVE_BLOCKED`，给出具体下一步。

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

## 项目上下文

默认项目是当前目录或其父目录中最近的 `.research/`。项目本地命令（`status`、`next`、`papers`、`ideas`、`report` 和 REPL slash 命令）只读取当前项目。没有项目上下文时返回可执行提示，不自动选择历史项目。

`ideaseek projects` 从用户级项目注册表列出已知项目、路径、最后运行、阶段和状态；`ideaseek open <path>` 为当前 CLI 会话选择项目；所有命令也支持 `--project <path>` 覆盖当前目录。项目注册表只保存路径和脱敏摘要，不保存论文、数据或 secret。路径失效时标记 unavailable，不删除项目记录。


