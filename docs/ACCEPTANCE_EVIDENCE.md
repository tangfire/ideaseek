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

## STAGE 4 — 协议与首次运行 Journey D（2026-11-20）

执行链与断言：

- `prepare --skip-model` → `[5/5] assessment: GAPS · protocol=BLOCKED · smoke=BLOCKED (2 blocking, 5 total gap(s))`，缺口如实：`papers-not-parsed`、`no-dataset`，各带准确 next 命令，exit 2。
- `protocol propose` 首次报 `no extracted PaperCards` → 按链补 `ingest`（首跑 PARSER_MISSING，见 I12）→ `extract`：`10 succeeded, 0 failed`（真实模型，key 已配置，未用 fake harness）。
- **修复 I12（setup.sh 不装 python worker 依赖，全新安装第一次 ingest 必死）**：现象=`ingest` 5/5 全失败 `pypdf is not installed`；根因=setup.sh 只检查 python 版本、从不安装 `worker/python/requirements.txt`（也从不建 venv）；改动=`setup.sh` 新增 `worker_deps_ok` + venv 自举（失败则打印手工命令并 exit 1）、新增 `tests/setup-worker-venv.test.ts`（4 例）；回归=该文件 4/4 绿 + `bash setup.sh` 实跑 exit 0（`worker deps: pypdf + pdfplumber importable`）；commit **50859d4**。
- **修复 I13（protocol propose 三连败）**：现象=两次运行共 6 次尝试全失败（`splitRules.source must be one of…` / `splitRules.confidence…` / `value must not be empty`，另 2 次模型 JSON 非法被重试）；根因=解压 session 逐字核对模型输出：splitRules/slicing 被输出成**裸数组**（丢 `{value,source,confidence}` 包装），且 Rules 文案旧写法 `slicing[]` 正好暗示裸数组；枚举此前只写在 taskDefinition 的 schema 行；改动=`src/experiment/protocol-synth.ts` Rules 行补全 `every "source" field must be one of [...]`（**56da8fd**）+ 明示数组放 `value` 内、`slicing[]` 改 `slicing.value[]`、prompt 版本 .4→.5→.6（**9ed1900**）；回归=`tests/protocol-propose.test.ts` 新增 enum + wrapper 两例（6/6 绿，连同 prompt-injection 11/11 绿）；修复后 `protocol propose` **1 次尝试通过**（run-4faa1715b8ba4a0f）。
- `confirm protocol` → **locked `proto-fb889c06d303-v1`**，hash sha256:9d450910…f034282，4 条低置信确认（splitRules/smokeTest/resourceEstimate/slicing）如实浮出并被覆盖。
- **comparison gate 停滞可见、不假装进入 idea 阶段**：`status` 阶段=`MATERIAL_INCOMPLETE`（datasets 阻塞）；`next` 给 datasets discover→authorize→acquire→link 链而非 idea；`idea list`=`no idea workspaces`；`assessment` exit 2，`[BLOCKING] no-dataset` + `[recommended] no-comparisons — the idea-stage gate will block until some exist`，每条带 evidence/fill-in/cost/blocks。

勘误（append-only，不改写 STAGE 3 行）：STAGE 3 的 5 篇 PDF 实为**截断下载**（无 `%%EOF`，`file` 仍报 PDF 1.5，sha 基线也记录的是截断件）——STAGE 4 ingest 暴露 `Stream has ended unexpectedly`。已用 `export.arxiv.org` + content-length 比对 + 断点续传重新下载，5/5 通过大小与 `%%EOF` 校验（2111.10487=5250951B、2306.01334=4325017B、2410.11267=9761211B、2402.06974=2950638B、2306.05879=4485783B），新 sha256 基线已记录，ingest 5/5 解析成功。根因是本机到 arxiv.org 主站限流/慢速导致 curl max-time 截断，非 ideaseek 缺陷（下载为 agent 侧动作）。

结论：STAGE 4 PASS（含 2 个已修复单点缺陷 I12/I13）。

## STAGE 5 — idea 闭环 Journey G 机器可验面（2026-11-20）

真实模型链（key 已配置），idea `gen-fed-domain-shaft-prototype`：

- `ideate --round new` → r1（snapshots 绑定 protocol proto-fb889c06d303-v1、manifest sha256）→ `idea generate --round r1` → 1 张候选卡 → `idea validate --require-candidate`（gate=CANDIDATE）→ `idea create --from-card`（scaffold 9 文件，nothing overwritten）→ `set-status IMPLEMENTING`。
- **真计算入口**：占位 scaffold 被 check 正确拒收（`FAIL smoke scaffold-placeholder — …these numbers mean nothing`，门禁有效证据）。重写为纯 Python 真计算（`src/fedg.py`：读本地 CSV → 按 x0 三分位确定域轴 → 种子化 logistic regression 在 seen domains 训练 → 留一域评估；5 个配置指标全部由真实预测导出；`smoke.py`/`train.py`/`check_metrics.py` 共用同一实现，无三方依赖）；单测从 1 例扩到 4 例（指标名对齐 config、准确率∈[0,1]、gap/通信量>0、**非占位值**）。
- `idea check` → **PASSED (status=SMOKE_TESTED)**，static/unit-tests/data/metrics/smoke 五相全绿。
- `idea experiment --json` → `resultStatus:"succeeded"`，5 指标入注册表（Unseen-domain top-1=0.5、Worst=0.5、Avg seen=0.6667、alignment gap=0.3、comm cost=240），`statusAfter: ANALYZING`。
- **失败实验不被删除（故意失败→重试）**：门禁先拒了两条捷径（代码改动→`check report is stale` 拒跑；已有成功结果→`alreadyRecorded` 幂等；状态 ANALYZING→`INVALID_STATE` 要求 walk back——均为正确行为）。按门禁走 NEEDS_REVISION→IMPLEMENTING→check 后，移走数据文件制造真实运行期失败：`resultStatus:"failed", failure:{category:"data", FileNotFoundError…}` 入 **v2**；恢复数据重试 → v3 succeeded。**v1/v2/v3 三份版本化结果文件全在**（`experiments/*-v2.json` 含 failed+failure 原文），task 表亦保留全部历史失败（paper.parse/protocol.propose failed 行未被清理）——失败记录未被删除 ✓。
- `experiment list` → 1 spec `succeeded`；`experiment show` → v3 带 command/metrics/explanation；`experiment leaderboard` → `1. gen-fed-domain-shaft-prototype 0.5000 v3 quick` ✓。
- 零 secret：全部输出无 key 命中（未做模式化扫描，输出中仅指标与状态）。

结论：STAGE 5 PASS。

## STAGE 6 — Journey H 跨机腿（2026-11-20，本服务器即"另一台机器"）

（`<workspace>/` 无用户上传的 `fdg-backup.tar.gz`，该可选子项 SKIP — no upload；主体按计划执行：）

- `ideaseek backup --json`（journey-a，含 init + 5 论文输入）→ `status:"ok"`，dir=`.research/backups/b-1795151564404`，逐文件 sha256 manifest（`path/bytes/sha256` 三元组，如 `artifacts/sha256/12/27/12270ec7…`）exit 0。
- 全新目录 `/mnt/workspace/restore-a` → `ideaseek restore <backupDir>` → `restored 18 file(s) … (every file hash-verified)` **exit 0** ✓。
- `doctor` → **ok=20 warn=1 error=0** exit 0（唯一 warn=latex，已知环境项）；跨路径 rebind 后 run 状态可读（`latest run run-4faa1715b8ba4a0f is COMPLETED`、recovery no repairs）。
- `status` → 可读并给出 next（`datasets discover → authorize → acquire → link` 链）**exit 0**。
- secret 扫描备注：粗模式 `sk-[A-Za-z0-9]+` 对 status 有 1 处**误报**——命中的是任务 ID `task-f2a81a31c6c34620` 中的 "sk-" 子串；加前界（前一字符非字母）与长度界后对 stage1/3/5/6/models 全部输出 **0 命中**。后续阶段一律用前界模式。

结论：STAGE 6 PASS（上传备份子项 SKIP: no upload）。

## STAGE 7 — Journey F 轻量面（2026-11-20）

- `ideaseek run --detach` → `detached supervisor started for run run-bb7feecbe91043ab (pid 90853)`，立即返回（supervisor 独立于本 shell 存活——detach 语义本身即"会话可断"的机器面）；demo 三任务（demo.ingest/analyze/report）由后台 supervisor 执行完毕，`daemon supervisor: pid 90853 exited(completed)`。
- `ideaseek status` → run COMPLETED、3/3 完成、事件流可见（run_created→task_enqueued×3→research_sync +4 nodes）exit 0。
- `ideaseek attach --run run-bb7feecbe91043ab` → **回放 21 条事件**（含 artifact_committed 的 sha256、task_succeeded、run_completed），`attach stopped (terminal); run=COMPLETED, events=21` exit 0。
- **心跳可见**：task 表 `heartbeat_at` 三任务均有值（1795151749873/1795151750170/1795151750444）；`ideaseek monitor` 快照给出 run 状态、资源与最近日志列表 exit 0。
- **已完成任务不重做**：再次 `ideaseek run --run run-bb7…` 走"新建下一周期"语义（新 run-c778fd035bfa4eba、全新 task 行），**run-bb7 的 3 条任务保持 attempt=1、原时间戳未被重新 lease**；工作流级同样只做一次——paper.parse/extract/protocol.propose 均只在其成功 run 中执行过一次，后续 run 未重跑（demo.ingest 复跑报 `ingested 0 input file(s)`，幂等）。
- **SSH 断线模拟：PARTIAL**——无法在本会话真实切断 SSH；以"detached supervisor 独立于调用 shell + status/attach 事后接管"等价验证，如实标注。

结论：STAGE 7 PASS（SSH 断线子项 PARTIAL）。
