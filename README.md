# IdeaSeek

IdeaSeek is a DSH-based multi-agent research workflow platform — 从研究问题到可验证发现的多 Agent 科研工作流命令行平台。

> **📖 文档站**：用浏览器直接打开 [docs/site/index.html](docs/site/index.html)，是本 README 的可浏览版（导航 / 搜索 / 可复制命令）。分步教程见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。

## 它能做什么

给 IdeaSeek 一个研究问题、论文和数据集，它会：

- **整理论文证据**：解析 PDF → PaperCard，证据定位到页，全文检索
- **发现与复现对比方法**：官方代码 / 论文重实现，许可与 commit 核验，隔离 clone
- **小规模验证 idea**：协议锁定 → comparison 门禁 → quick/smoke 实验 → 消融与失败分析
- **全量实验与论文交付**：`HANDOFF_READY` 后跑 full-scale comparison，产出图表与 Overleaf 论文工程
- **全程可恢复**：租约、checkpoint、断线 attach、暂停/恢复——长任务从最小断点继续

## 安装

前置：Node.js ≥ 24.9、pnpm（`corepack enable`）、Python 3 + `pip install pypdf pdfplumber`（论文解析）。

```bash
git clone <repo> ideaseek && cd ideaseek
node scripts/install.mjs    # 一条命令：自举依赖 → 构建 → 装入 ~/.ideaseek
ideaseek doctor             # 验证安装（新 shell 生效）
```

- **POSIX**：TTY 下会先征求确认，把带标记的 PATH 块写入 `~/.profile`（`--no-path` 跳过）
- **Windows**：launcher 在 `%USERPROFILE%\.ideaseek\bin\ideaseek.cmd`，把该目录加入用户 PATH 后开新终端即可（PowerShell 一行命令见 `scripts/install.mjs` 输出的 next 提示）
- GPU / 服务器 / WSL2、升级回滚等完整说明：[docs/PACKAGING.md](docs/PACKAGING.md)

正式发布后（目标形态）：`npm install -g ideaseek`。

## 使用：5 分钟上手

```bash
ideaseek init                           # 创建项目结构（papers/ datasets/ comparisons/ …）
ideaseek setup                          # 环境探测，写 research.yaml
ideaseek start --question "你的研究问题"  # 小白一键入口
```

1. 放入材料：论文 → `papers/`，数据 → `datasets/`，对比代码 → `comparisons/`（不确定的丢 `incoming/`）
2. `ideaseek scan` → `ideaseek intake`（确认归类，原文件永不移动）→ `ideaseek plan --question "…"`（干跑：看门禁、资源与阻塞）
3. `ideaseek run --question "…"` 启动；`ideaseek next` / `ideaseek status` 随时看进展
4. 日常入口是**交互界面**：

```bash
ideaseek interactive     # 或直接敲 ideaseek
```

**模型配置在 TUI 里完成**：输入 `/models setup`，输入行切成掩码状态（`🔐 … •••`）粘贴 API key——默认先做连通性测试，坏 key 零写入；key 值从不进 argv、不落项目文件。`/models` 查看 route/凭据状态，`/models use <route>` 切换项目 route。

## 命令速查

### 交互界面（启动后输入 `/` 打开命令面板）

| 分组 | 命令 |
| --- | --- |
| 概览 | `/help` · `/status` · `/next` |
| 审批 | `/pending` · `/approve [n]` · `/reject <reason>` |
| 研究 | `/papers` · `/comparisons` · `/ideas` · `/experiments` · `/logs <task-id>` |
| 构思 | `/rounds` · `/ideate` · `/feedback` |
| 会话 | `/models` · `/mode` · `/open` · `/report` |
| 控制 | `/pause` · `/resume` · `/continue` · `/cancel` · `/quit` |

交互要点：

- **自然语言直接输入**：如“为什么 method-x 还没通过”“优先验证 idea-001”——只读查询即时回答，高影响请求生成**待审批 Decision**，绝不静默执行
- `Shift+Tab` 切换 Research / Agent 模式；Agent 模式里每条消息是一次真实 DSH 回合，工具审批显示 `y allow once · n/Enter reject`
- **滚轮**回看全部历史（实时输出照常在底部滚动）；`Ctrl-C` 中断当前命令；`Ctrl-D` / `/quit` 退出（**后台 run 不取消**）
- 输出三类行：`❯` 你的输入 · 普通行=响应 · `[HH:MM:SS]`=持久化事件

### 核心 CLI（脚本 / SSH 场景，每条都有等价斜杠命令）

| 命令 | 用途 |
| --- | --- |
| `init` / `setup` / `start` | 初始化项目 / 环境探测 / 小白一键入口 |
| `doctor` | 健康检查：版本、GPU、凭据脱敏状态、修复指引 |
| `scan` / `intake` / `organize` | 发现输入 / 归类确认 / 落盘索引（原文件永不移动） |
| `plan --question "…"` | 干跑：材料、任务量、门禁、资源、阻塞 |
| `run --question "…"` | 创建并执行工作流（可 `--enqueue-only`） |
| `next` / `status` | 下一步建议（不启动高成本动作）/ 运行状态 |
| `report` / `events` / `attach` | 事实报告 / 事件回放 / 实时订阅 |
| `pause` / `resume` / `continue` / `cancel` | 可审计的运行控制 |
| `models` / `mode` | 模型 route 与配置（`models setup` 配 key）/ Research·Agent 模式 |
| `ask "<text>"` | 自然语言入口（查询 / 待审批 / supervisor 分类） |
| `agent "<prompt>"` | 一次真实 DSH coding-session 回合（`--resume` 续会话） |
| `open` / `pending` / `logs <task-id>` | 切换项目 / 待审批清单 / 脱敏任务日志 |
| `backup` / `restore` / `projects` | 快照与恢复 / 已注册项目列表 |

退出码：`0` ok · `1` failed · `2` blocked/需输入 · `3` 运行中 · `4` canceled。全部命令、参数与退出码见 [docs/CLI_SPEC.md](docs/CLI_SPEC.md)。

## 文档地图

| 入口 | 内容 |
| --- | --- |
| [docs/site/index.html](docs/site/index.html) | **文档站**：可浏览的使用指南（安装 → 工作流 → 命令） |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | 分步教程：安装、配模型、材料、运行、恢复、交付 |
| [docs/CLI_SPEC.md](docs/CLI_SPEC.md) | 全部命令、参数与退出码（规范来源） |
| [docs/TERMINAL_UX.md](docs/TERMINAL_UX.md) | TUI 交互规范：输入行、审批、滚动、事件流 |
| [docs/MODEL_ROUTING.md](docs/MODEL_ROUTING.md) | 模型分层与 route 语义 |
| [docs/PACKAGING.md](docs/PACKAGING.md) | 安装 / 发布 / 升级 / 回滚 / 平台支持 |
| [docs/DOCUMENTATION_PLAN.md](docs/DOCUMENTATION_PLAN.md) | 文档目录与发布方式 |

## 开发者

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm test             # vitest + python worker 测试
pnpm release-check    # 依赖许可白名单 + tracked-file secret 扫描
```

入口文档按顺序读：[docs/AGENTS.md](docs/AGENTS.md) → [docs/README.md](docs/README.md) → [docs/BOOTSTRAP_DEVELOPMENT.md](docs/BOOTSTRAP_DEVELOPMENT.md)；设计与进度分别见 [docs/plan.md](docs/plan.md) 和 [docs/PROGRESS.md](docs/PROGRESS.md)。
