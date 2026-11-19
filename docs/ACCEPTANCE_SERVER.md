# IdeaSeek 服务器实机验收（ACCEPTANCE_SERVER.md）

你在一台全新 Linux（ModelScope DSW，工作区 `/mnt/workspace`）上以"新用户 + 验收者"双视角执行本计划。**本文件随仓库分发，是唯一准则**（与 `docs/AGENTS.md` 冲突时以本文件为准；其"推送"类规则与本文件第 4 节方向一致）。

路径约定：**工作区根 = 本仓库的父目录**（下文 `<workspace>`，当前即 `/mnt/workspace`）。验收用的全新项目建在 `<workspace>/journey-a`（仓库之外，不污染仓库）。

## 铁律（违反即验收无效）

1. **密钥零接触**：绝不读取、输出、代输任何 API key 值。模型 key 由用户亲自 export 到环境（`~/.bashrc`）；凭据文件（`~/.git-credentials` 等）绝不进入仓库、绝不打印。无 key 的阶段如实标 `SKIP (no credential)`，不得伪造通过。
2. **原始输入只读**：`papers/`、`datasets/`、`comparisons/` 原件不移动、不改名、不覆盖。
3. **不得删除任何恢复/审计/证据类检查来让测试变绿**；失败 = 如实 FAIL + 证据。
4. **证据 append-only**：所有证据写入 `docs/ACCEPTANCE_EVIDENCE.md`（仓库内，只追加不改写历史行）。
5. **凭据不进仓库**：git 提交者信息用本机身份（见第 4 节），任何 token/密码只存在于全局 git credential store。

## 有界修复自主权（发现问题可以自己修）

- **可自动修**：单点缺陷——改代码/文案/脚本 → **补回归测试** → 跑目标测试通过 → 一个小 commit → 按第 4 节推送。修不了或 3 次尝试仍失败 → 停手，证据里记 `BLOCKED` + 已尝试内容。
- **只记录不擅动**：架构改动、依赖大版本升级、密钥/权限相关、删除测试或检查——写进证据的"待修清单"，留给上游决策。
- 每个修复在证据里记：现象 → 根因 → 改动文件 → 回归测试名 → commit hash。

## 提交与推送（gitee 是协作主干）

```bash
# 一次性配置（用户已完成则跳过）：
git config --global credential.helper store   # 凭据只落 ~/.git-credentials，不进仓库
git config user.name  "ideaseek-server"       # 本机提交者身份
git config user.email "server@local"
```

每个 STAGE 完成或每个修复完成时：

```bash
git add -A && git commit -m "<类型>(<范围>): <一句话>"
git pull --rebase origin main     # origin = gitee；先拉后推，保持线性
git push origin main              # 冲突 → 解决后重试一次；仍失败 → 证据记 BLOCKED + 冲突文件列表
```

- **禁止 force push、禁止改写已推送历史、只动 main**。
- 不向 github 推送（上游同步由本地 agent 从 gitee 拉取后完成）。
- 提交信息用英文 conventional 风格（与仓库历史一致）。

## 阶段清单（按序执行，每阶段输出摘要）

每阶段结束输出固定格式（便于回传）：

```
=== STAGE <n>: <名称> ===
结果: PASS | FAIL | SKIP (<原因>)
证据: docs/ACCEPTANCE_EVIDENCE.md L<起>-L<止>
摘要: <3 行以内>
```

### STAGE 0 — 安装与自检

```bash
cd <workspace>/ideaseek && git pull --rebase origin main && bash setup.sh
node dist/cli.js --version
node dist/cli.js doctor    # 记录 ok/warn/error；credentials 行只记 presence
```

`setup.sh` 自举缺失的 Node ≥24.9 与 pnpm（国内镜像默认，`IDEASEEK_NPM_REGISTRY` 可覆盖）。失败则按报错手工补齐（Node 24 → pnpm → `pnpm install --registry=https://registry.npmmirror.com` → `node scripts/build.mjs`）并记证据。

**模式顺序**（按产品设计）：先 Analysis（准备链 scan→ingest→data→extract/synthesize→assessment，只读）→ 材料就绪后进 Research（run/idea/实验）。**数据集下载是显式授权门禁**（discover→authorize→acquire，用户批准才下载）——这是设计不是缺陷，STAGE 9 必须走完整授权链。

### STAGE 1 — Journey A（全新目录首次使用）

在 `<workspace>/journey-a`：`init → init（幂等）→ start → next → status`。完整标准见 `docs/USER_JOURNEY_ACCEPTANCE.md`。断言：
- doctor 人话、零 secret、缺项给准确命令；init 幂等
- start 空项目提示最小输入，**且露出 demo 入口**（`ideaseek run --question`）
- `next` 可复制，且**不得**是 `plan --question`（dry-run 不持久化）
- 执行 `next` 给的命令后再次 `next`，**阻塞项确实减少**（推进性验证，核心回归）

### STAGE 2 — Journey B（模型配置，用户亲自操作）

用户在独立终端完成 key 配置（`export DEEPSEEK_API_KEY=*** `~/.bashrc`）。你执行 `ideaseek models list` 与 `models list --json`：断言四层路由齐全、JSON 对 `sk-`/`ghp_`/`Bearer` **零命中**。用户未配 key → SKIP，后续模型步骤如实跳过。

### STAGE 3 — 材料输入（Journey C，agent 自己下载论文）

方向：**联邦学习域泛化**。研究问题（`plan --question` 用）：

> 联邦学习中各客户端数据来自不同域（风格、成像设备、传感器与场景差异），且测试域在训练时不可见：如何在保持客户端数据不出域的前提下，学到跨域不变且类间可分的表示，使 unseen-domain 准确率超过现有 FedDG/原型类 SOTA？

1. 下载该方向 **3–5 篇公开论文 PDF**（arXiv open-access 优先，可与 FDG 语料不同篇目）→ `<workspace>/journey-a/papers/`
2. `scan → intake`（记分组/confidence 证据）→ `intake --confirm` → `organize`（preview 为主）
3. `plan --question "<上面的问题>" --json`：断言 dry-run（`startedNothing:true`、`questionPersisted` 如实）
4. 断言原始 PDF 前后 sha256 不变

### STAGE 4 — 协议与首次运行（Journey D）

`prepare --skip-model`（或 assessment）→ 记缺口 → `protocol propose`（无 key 用 `--harness fake` 并如实标注）→ `confirm protocol` → 观察 comparison gate 停滞。断言：阶段/阻塞可见，不假装进入 idea 阶段。

### STAGE 5 — idea 闭环（Journey G 机器可验面）

`idea generate`（无 key 则手写最小 IdeaCard → `idea create --from-card`）→ IMPLEMENTING → `scaffold` → 真计算的 `src/smoke.py`（输出 `{"metrics": {...}}`）→ `idea check` → `idea experiment --json`（gpus:0 smoke 规模）。**自己写的入口跑不通时：按第 2 节修复自主权修到 check 全绿（3 次失败记 BLOCKED，不许绕过检查）**。断言：结果进注册表、失败实验不被删除（可故意失败一次再重试）、`experiment leaderboard` 能列出该结果。

### STAGE 6 — Journey H 跨机腿（本服务器即"另一台机器"）

1. 小项目（init + 任意输入）→ `backup --json`（记 sha256 manifest）
2. 全新目录 `restore <backupDir>` → 断言"hash-verified"与退出码 0
3. `doctor`（error=0）→ `status`（可读、给 next）
4. （若用户上传了 `fdg-backup.tar.gz` 到 `<workspace>/`：同法 restore 真实 FDG 备份，证据价值更高）

### STAGE 7 — Journey F 轻量面

`run --detach` → `status` → `attach`/`resume`；断言事件/心跳可见、已完成任务不重做。SSH 断线模拟做不了则如实 PARTIAL。

### STAGE 8（可选）— Linux 全量回归

`apt-get install -y poppler-utils` → `pnpm test`（约 7–10 分钟，无 key 用例自动 skip）。记录文件数/通过数/失败数，失败逐条列名。

### STAGE 9 — 数据集自主获取

`datasets discover --question "<研究问题>" --json` → `explain` → `authorize --grant --reason "..."` → `acquire --max-gib 50 --timeout-ms 600000 --confirm` → `data describe`。网络/源不可达 → FAIL/SKIP 附原始错误，**绝不假装获得数据**。

### STAGE 10 — 自主切片

`data slices` → 断言 train/test × smoke/quick/standard 切片与 manifest（rootHash 可复核）；证据：切片清单 + 单切片样本数/标签分布。

### STAGE 11 — 并行多 idea + 对比算法 + 实验设计

1. `ideate --round new --ideas 3`（无 key 用 fixture 卡片）→ 3 张 IdeaCard
2. 对比算法：`comparison plan` → required 方法 → 源获取（**github 可达性是已知风险**）。**若某 required 方法无源可用：自己写一个最小可跑的基线实现**（如 FedAvg 骨架：读本地数据 → 按协议训练 → 打印指标 JSON）放进 `comparisons/<method-id>/`，以 `comparison smoke` 过门为准——**写完必须跑通，跑不通按第 2 节修复自主权修到通（3 次失败记 BLOCKED）**；确实无法完成则如实 SKIP 附探测证据
3. 每个 idea：create → IMPLEMENTING → 真计算 smoke 入口 → `idea check` 全绿
4. **并行**：`idea run-ready --scale quick --json` → 断言多 idea 一次放行（queued 空、RunResult 时间窗重叠证据）
5. `protocol propose` → `confirm protocol`

### STAGE 12 — 全量运行（验收清单唯一未勾的"独立 full-run"）

`full plan --idea <最终idea>` → `full fairness` → `full approve --confirm` → `full run`。CPU 上可能数小时：允许分步；预计超时则如实标 `PARTIAL（挪至 GPU 阶段）` 并附前置证据。断言：全部 required comparison 执行、失败不被静默跳过、`paper results` 可导出复核。

### STAGE 13 — 模式与指令面（Journey E 补充）

在 `<workspace>/journey-a`（已初始化项目）上，覆盖三档模式与常用指令：

1. `ideaseek mode` → 显示当前档位（默认 research）与项目/权限信息
2. **切换不清空上下文**（MODES.md 契约）：`ideaseek mode analysis` → `ideaseek status` 的 run 数与切换前一致（不建第二个 run、不重复成功任务）→ `ideaseek prepare --skip-model` 在 analysis 档可跑（只读准备链）→ `ideaseek mode research` 切回 → `status`/`next` 输出与切换前语义一致
3. **三态一致**：任选 `status` 与 `next`，各跑 human / `--plain` / `--json` 三态——JSON 可解析、三种态结论一致、对 `sk-`/`ghp_`/`Bearer` 零命中
4. **TUI 指令面**：`ideaseek interactive`（或 TUI）里 `/help` 分组完整，`/status`、`/next`、`/papers`、`/ideas` 各 relay 一次且有真实输出
5. **coding 档**：`ideaseek mode coding` 切换后 `mode` 显示正确、`/agent` 入口存在即可——**不强制真跑 coding turn**（成本与审批面另行验收，如实记 SKIP 范围）

## 最终产出

1. `docs/ACCEPTANCE_EVIDENCE.md` 末尾追加汇总表：

| Journey | 结果 | 证据行 | 备注 |
|---|---|---|---|

2. ≤10 行总结：PASS/FAIL/SKIP 各几项、最值得修的 1–3 个问题、"是否可上线"的机器侧意见（如实，不粉饰）。
3. 按第 4 节提交并推送（证据 + 期间产生的所有修复）。

## 冷启动说明（供本地/上游 agent 接续）

**分工（负责人口径，2026-11-19 定案）**：验收的判断、修复、优化、推进**全部归属服务器 agent**；本地 agent 的职责是 **gitee → github 同步**——`git pull gitee main` → 确认远端历史线性 → `git push github main`。同步时顺带扫一眼推送内容：仅当发现明显破坏铁律/门禁的改动（删测试换绿、提交了凭据）时向用户示警，**不代为实现修改**（除非用户明确要求）。证据与状态的权威文件是 `docs/ACCEPTANCE_EVIDENCE.md` 与 `docs/PROGRESS.md`，均随服务器推送而来，同步即得。
