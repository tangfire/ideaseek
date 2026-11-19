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
