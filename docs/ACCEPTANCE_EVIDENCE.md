# ACCEPTANCE EVIDENCE（append-only）

执行计划：[ACCEPTANCE_SERVER.md](ACCEPTANCE_SERVER.md)。**只追加，不改写历史行**；每个 STAGE 按计划中的摘要格式落行。

## 安装阶段（2026-11-19，DSW-CPU 裸机，本地 agent 修复 + 用户执行）

| # | 现象 | 根因 | 处置 | commit |
|---|---|---|---|---|
| I1 | `setup.sh: pnpm: 未找到命令`（依赖安装第一步） | 自举 node 后 `npm i -g pnpm` 落在 npm prefix bin（`/usr/local/lib/node-ideaseek/bin`），该目录不在 PATH；装完未复验 | npm prefix bin 立即入 PATH + pnpm 装后复验失败即停 + ideaseek/pnpm 持久软链进系统 PATH 目录（脚本内 PATH 导出不跨 shell） | 91788ce |
| I2 | `npm warn allow-scripts … pnpm install scripts not covered` | npm ≥11.17 默认拦截 install scripts | 装 pnpm 时 `--allow-scripts=pnpm` 显式放行，旧 npm 不识别则降级重试 | 91788ce |
| I3 | `ERR_PNPM_IGNORED_BUILDS`：node-pty / koffi / protobufjs / @deepseek-ai/dsh-subprocess-local / @google/genai 构建脚本被拦 | pnpm ≥10 要求构建脚本白名单（安全默认） | package.json 声明 `pnpm.onlyBuiltDependencies`（5 项，均为 harness/交互栈运行时依赖）；新增依赖仍须显式声明 | a11f46a |
| I4 | `Ignoring broken lockfile … lockfileVersion 6.0 is incompatible (pnpm 12 supports 9.x)` → 安装绕过锁文件全量重新解析（eslint/prettier 等与本机解析结果漂移） | 仓库锁文件是 pnpm 8 时代产物；现代 pnpm 不读，`pnpm install --frozen-lockfile` 在新 pnpm 上会硬失败——**安装不可复现** | **待修**：用 pnpm ≥9 重新生成锁文件 + `packageManager` 钉版本；需本地重装 node_modules + 全量门禁后单独提交（验收并行期处理） | — |
| I5 | 第二次运行 setup.sh 时 node bootstrap 幂等重跑了一次（无害，随后 node_ok 通过） | 未定位（疑瞬态 PATH/hash）；自愈 | 观察项：第三次复发则带 `ls -l /usr/local/bin/node` 证据排查 | — |

环境备注：DSW-CPU 8核32G / Ubuntu 22.04 / python 3.11.11 / root；pdflatex 与 SVG→PDF 转换器缺失（论文图表步骤预期 SKIP，如需 `apt install texlive-latex-recommended librsvg2-bin`）。

## 安装阶段·续（2026-11-19，同一日第二轮）

| # | 现象 | 根因 | 处置 | commit |
|---|---|---|---|---|
| I6 | package.json 声明白名单后服务器仍报 `ERR_PNPM_IGNORED_BUILDS`，且 WARN "The 'pnpm' field in package.json is no longer read" | pnpm 12 不再读 package.json `pnpm` 字段；其设置新家是 pnpm-workspace.yaml，且键从 10/11 的 `onlyBuiltDependencies` 数组变为 `allowBuilds` 映射（`pnpm approve-builds --all` 写出的即权威格式） | 新增 pnpm-workspace.yaml（allowBuilds 五项），删除 package.json 死字段 | c3ed6bb |
| I4（闭合） | 现代 pnpm 忽略 v6 锁文件重新解析（不可复现）；`--frozen-lockfile` 在新 pnpm 上硬失败 | 锁文件是 pnpm 8 时代产物 | 用 pnpm 12.21.0 重新生成（lockfileVersion 9.0，通过 supply-chain 校验），`packageManager` 钉 pnpm@12.21.0，本地全局 pnpm 对齐同版本 | c3ed6bb |

验证：本地 pnpm 12.21.0 `pnpm install` → "Lockfile is up to date" 57ms 绿；postinstall 实跑（node-pty conpty、dsh-subprocess spawn-helper 均 Done）。依赖全量重解析后的全量门禁见提交后 CI/门禁记录。

## 安装阶段·续二（2026-11-19，I5 复发 → 根因 + 修复）

| # | 现象 | 根因 | 处置 | commit |
|---|---|---|---|---|
| I5（复发→闭合） | node bootstrap 连续三轮在新 shell 重跑；`git pull` 被失败安装的本地残留挡住（pnpm-lock.yaml 脏 + 未跟踪 pnpm-workspace.yaml） | ① bootstrap 的 `export PATH` 只活在本进程，从未写 rc；② persist_link 里 ensure 先于 export 的顺序颠倒（ensure 见 PATH 已有 → 永不写 rc）——新 shell 缺 `/usr/local/bin` 时每次都当 node 缺失重来 | 函数上移到首次使用之前；bootstrap 与 persist_link 均**先写 `~/.bashrc` 再入进程 PATH**；pull 残留由 `git checkout -- pnpm-lock.yaml && rm pnpm-workspace.yaml` 清除（失败安装的产物，非用户工作） | f636e7c |

## 安装阶段·续三（2026-11-19，全局命令静默失效）

| # | 现象 | 根因 | 处置 | commit |
|---|---|---|---|---|
| I8 | 全局 `ideaseek` 在服务器上**零输出**：`--help`/`status`/裸命令全部静默 exit0，stdout 仅剩 169 字节 SQLite 警告（`tty` 正常、模块加载正常） | 入口直调检测用字符串裸比 `argv[1]` 与 `import.meta.url`：npm link 给的是**符号链接**——argv 保留链接路径、meta 是解析后的真实文件 → 比较失败 → 主块被跳过 → 加载完静默退出。测试从未暴露：要么直跑真实路径、要么带 `IDEASEEK_CLI=1` 旁路 | 检测改为 `realpathSync` 后比较（路径失效时回退原式）；新增 symlink 回归用例（Windows 无权限时**显式 SKIP，不假绿**）；实测验证 = 服务器 pull+build 后 `ideaseek --help` 恢复输出 | 1c2e7ca |

## 修复轮（2026-11-19，STAGE 0 前置，服务器 agent）

| # | 现象 | 根因 | 处置 | commit |
|---|---|---|---|---|
| I9 | `doctor` 报 `✗ node v22.23.2 (required >=24.9)`、exit 2：setup 明明已把 Node v24.19.0 自举到 `/usr/local/bin`，但 shell 里 `node` 仍是 v22 | `ensure_persistent_path` 用"当前进程 PATH 是否已含该目录"决定是否写 `~/.bashrc`；本机 `/usr/local/bin` 在进程 PATH 里（只是排在 nvm 之后）→ 早退、rc 永不写 → 新交互 shell 启动时 nvm 把 v22 插到最前，doctor 永远红 | 改为只按 rc 内容决策（grep 已有行防重复）；新增 `tests/setup-path-persist.test.ts`（4 例：被遮蔽仍写 / 缺目录写 / 幂等 / rc 已有不重复；旧逻辑反证 rc 0 字节）；`vitest run tests/setup-path-persist.test.ts` 4/4 绿，prettier + eslint 过 | bc644b0 |
| I10 | I9 修复 + 重跑 setup 后，非交互 shell（工具会话）仍解析 node v22 | 非交互 shell 不加载 `.bashrc`（`[ -z "$PS1" ] && return` 守卫 + bash 默认不读），PATH 是 DSW 会话启动时继承的固定环境，nvm v22 目录钉在最前；rc 修复只覆盖交互终端 | 机器本地修复：`ln -sf /usr/local/lib/node-ideaseek/bin/node /root/.nvm/versions/node/v22.23.2/bin/node`（npm/npx 保留 nvm 原件，全局 prefix 语义不变）；`node --version` → v24.19.0、npm 10.9.8 正常；可逆（`nvm reinstall-packages 22.23.2` 即还原） | —（机器本地，不进仓库） |

补丁后整机复跑：`bash setup.sh` exit 0（幂等：install "Already up to date"、build 重跑、rc 落盘 `export PATH="/usr/local/bin:$PATH"` 恰 1 行）。

## STAGE 0 — 安装与自检（2026-11-19）

- `git pull --rebase origin main`：已是最新；修复 bc644b0 已按第 4 节推送。
- `bash setup.sh`：exit 0。首跑自举 Node v24.19.0（npmmirror）+ pnpm 12.21.0 + python 3.12.13 + 依赖安装（Lockfile up to date）+ `node scripts/build.mjs` + 全局 `ideaseek` 链接；I9 修复后复跑仍 exit 0。
- `node dist/cli.js --version` → `0.1.0`（exit 0）。
- `node dist/cli.js doctor`（修复后）→ `ok=7 warn=2 error=0`，exit 0：
  - ✓ node v24.19.0（required ≥24.9）/ python 3.12.13 / container docker 28.1.0 / gpu NVIDIA A10 ×1 / disk 1004 TiB free / credentials / dsh pinned fcc0ad462172
  - ⚠ project：`no .research/ found here; run: ideaseek init`（预期，STAGE 1 前未初始化）
  - ⚠ latex：pdflatex 缺失；· svg-converter 缺失（均为已知环境备注，论文编译/图表步骤预期 SKIP）
  - credentials 行只记 presence：`env DEEPSEEK_API_KEY is set`（值未读取、未打印）
- 修复前首跑 doctor 为 `ok=6 warn=2 error=1`（node ✗ v22）→ 已按第 2 节修复自主权闭合（I9/I10）。

## STAGE 1 — Journey A 全新目录首次使用（2026-11-20）

前置：发现上一会话在 STAGE 0 提交后（11-19 23:51）已建 `/mnt/workspace/journey-a` 半成品但未落证据；为满足"全新目录"语义，改名保留为 `journey-a-partial-20261119`（可逆，不删除），新建空目录执行。

| # | 现象 | 根因 | 处置 | commit |
|---|---|---|---|---|
| I11 | STAGE 0 后新会话 `doctor` 又报 `✗ node v22.23.2`、exit 2 | I10 机器本地修复（nvm bin 的 node 符号链接）随 DSW 会话重启被还原为 nvm 原始 v22 二进制；非交互 shell PATH 中 nvm 目录仍排在 /usr/local/bin 之前 | 机器本地重放 `ln -sf /usr/local/lib/node-ideaseek/bin/node /root/.nvm/versions/node/v22.23.2/bin/node`；复验 `node --version`=v24.19.0、npm 10.9.8；不进仓库（交互 shell 侧已有仓内修复 I9） | —（机器本地） |

执行与断言（均在 `/mnt/workspace/journey-a` 全新空目录，命令与输出原文）：

1. `ideaseek doctor`（空目录）→ `ok=7 warn=2 error=0` exit 0：人话缺项提示 `no .research/ found here; run: ideaseek init`；credentials 行仅 presence（`env DEEPSEEK_API_KEY is set`，值未读取）；零 secret（机器 grep `sk-|ghp_|Bearer` 对 doctor/start/next/status 全量输出 = 0 命中）。
2. `ideaseek init` #1 → `initialized ... directories: 10, created: research.yaml, README.md, .gitignore` exit 0；#2 → `already initialized` exit 0 —— **幂等 ✓**。
3. `ideaseek start`（空项目）→ 最小输入提示（papers/datasets 放置 + 重跑 start）**且露出 demo 入口** `ideaseek run --question "..."（demo 流水线，不需要论文）` ✓。
4. `ideaseek next` → 下一条命令 `ideaseek setup --question "..."`（**非** `plan --question`，dry-run 不持久化的产品规则 ✓），可直接复制。
5. 执行该命令（写入 STAGE 3 研究问题，research.yaml 带 `.bak-1795142308410` 备份）→ 再次 `next`：**阻塞由 3 项（question/papers/datasets）降为 2 项（papers/datasets）**，question 阻塞消失并给出 `scan && ingest` 推进建议 —— **推进性验证 ✓（核心回归）**。
6. `ideaseek status` → 可读（项目/Run/研究链阶段/下一步命令）exit 0 ✓。

结论：STAGE 1 PASS。期间唯一缺陷 I11 为机器本地环境复发（非代码缺陷），已重放修复。

## STAGE 2 — Journey B 模型配置（2026-11-20）

用户已在本机亲自配置 key（STAGE 0 doctor 已记 presence：`env DEEPSEEK_API_KEY is set`；本阶段不读取、不打印任何 key 值）。

- `ideaseek models list` → exit 0，**四层路由齐全**：fast / balanced / deep / deterministic，各带角色绑定（fast: paper_extractor+paper_vision；balanced: 6 角色；deep: 6 角色；deterministic: evidence_checker+workflow_supervisor 且 no model）；凭据仅 presence（`deepseek api key configured (presence only)`、`credentialRef=env:DEEPSEEK_API_KEY [configured]`）。
- `ideaseek models list --json` → exit 0，`JSON.parse` 通过；机器扫描 stdout+stderr 对 `sk-[A-Za-z0-9]`/`ghp_[A-Za-z0-9]`/`Bearer [A-Za-z0-9]` **零命中**（0/0）。
- JSON 内嵌规则自述："Agent cannot read or modify API keys — presence is reported only"、"deterministic tier never calls a model"，与 Journey B 验收一致。

结论：STAGE 2 PASS（非 SKIP，key 已由用户配置）。

## STAGE 3 — Journey C 材料输入（2026-11-20）

方向：联邦学习域泛化。论文由验收 agent 用 curl 从 arXiv 下载（材料输入按计划由 agent 准备；ideaseek 自主数据获取在 STAGE 9 的授权链验证）。

- 下载 5 篇公开 PDF → `/mnt/workspace/journey-a/papers/`（arXiv 2111.10487 Federated Learning with Domain Generalization / 2306.01334 FedDG Survey / 2410.11267 FedCCRL / 2402.06974 Hypernetwork-Driven Model Fusion / 2306.05879 FedWon），`file` 均为 PDF 1.5；下载后记录 sha256 基线。
- `ideaseek scan` → `scanned 5 file(s)`、`roles: paper=5`、`groups: 5 · duplicates: 0 · reused hashes: 0`，manifest/review 落 `knowledge/`。
- `ideaseek intake` → 5 候选分组，**分组/confidence 证据**：全部 `paper conf=0.95 [same-filename-stem]`（grp-30799402…/580f02b0…/86ed30a5…/8c50878c…/9fde4481…）。
- `ideaseek intake --confirm <grp>` ×5 → 全部 confirmed，回执"exact reviewed file set - membership changes invalidate it"。
- `ideaseek organize`（**preview**）→ `5 index entries would be created`、明确 `originals are never moved or modified`，未加 --apply（按计划 preview 为主）。
- `ideaseek plan --question "<研究问题>" --json` → exit 0 可解析：**`startedNothing:true`（dry-run ✓）**、`inputs.paperFiles=5`、`estimates` 基线如实标注 "not a provider quote"/"budget ceiling"、`blockers:["no protocol proposal yet"]`、`run:null`。`questionPersisted:true` **如实**——研究问题由 STAGE 1 `setup --question` 写入，plan 后 `research.yaml` mtime 仍为 setup 时刻（10:38，plan 于 10:5x 执行）、无新 .bak，即 plan 未持久化任何东西；无参 `plan --json` 同为 startedNothing:true。
- 断言原始 PDF 前后 sha256 一致：`sha256sum -c` 5/5 成功（exit 0）。
- 零 secret：plan JSON+stderr 对 `sk-|ghp_|Bearer` 零命中。

结论：STAGE 3 PASS。
