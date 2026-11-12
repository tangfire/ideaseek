# Build-vs-Reuse 审查（Phase 8）

对照 [DEPENDENCY_POLICY.md](DEPENDENCY_POLICY.md) 的评估顺序，对当前代码面做一次真实核查（grep 证据，非纸面声明）。审查范围：Agent 调用面、状态存储、TUI/dispatch、子进程、契约校验、ARIS 能力、Python 侧、依赖清单。

日期：2026-11-13 · 分支 `feat/phase0-recovery` · 证据可由文中 grep 命令复验。

## 结论一览

| 能力域 | 首选来源 | 审查结果 | 证据 |
|---|---|---|---|
| LLM/Agent 调用 | DSH HarnessAdapter | ✅ 单一入口 | `grep -rn "api.deepseek\|chat/completions\|api.openai" src` → 0 命中；12 个命令经 `buildHarness`；`src/dsh-plugins/*` 是 DSH 侧插件（sanctioned） |
| 任务/事件存储 | workflow/sqlite | ✅ 单一存储 | `appendEvent/createRun/claimNextTask` 只在 `src/workflow/*` 定义；commands 只调 `runtime.db.*` API；attach/follow 轮询同一 DB |
| TUI | Ink | ✅ 单一 TTY renderer + 单一 dispatch | `interactiveRenderer` 路由单测钉住；classic 行式仅服务 plain/json/非 TTY/FORCE_TTY；`1974229` 后 classic 与 Ink 共用 `InteractiveSession`（repl.ts 782→367 行），架构守卫断言 session 不碰 sqlite 且必达 runner |
| 子进程 | tree-kill + `core/proc.ts` | ✅ 主路径统一，2 处探针待迁移 | `runProcess/killTree(ForSafe)` 覆盖 relay(runCli)、extract 并行 worker、comparison git/repair、pdf/OCR、federated、embeddings；**待迁移**：`runtime/detect.ts`、`runtime/capacity.ts` 的探针仍是裸 `child.kill`（单叶子进程+超时，无孙进程风险，低优先级）；`commands/run.ts` spawn 的是 deliberately detached 的 supervise daemon（不该被树杀，合理例外）；`commands/render.ts`、`knowledge/wiki.ts` 的 python helper spawn 无超时杀（候选迁移） |
| 契约校验 | JSON Schema + ajv | ⚠️ 4 个契约已统一，约 20 个模块仍是手写校验 | 已统一：`papercard-v1`（写读双门禁）、`parsed-paper-v1`（TS+Python 同文件）、`experiment-spec-v1`/`run-result-v1`（与手写 validator 决策一致性）；**待迁移清单**即 PROGRESS「JSON Schema 统一」checkbox：结构层迁 schema、语义层留领域模块（spec 时间序等），迁移顺序按跨语言消费紧迫度 |
| ARIS 科研 workflow | vendored skills | ✅ 21 个 skill 入库未重写；平台侧只做契约+接线 | `aris-skills/` + manifest 54 文件哈希校验；`grep` 无第二套 prompt workflow；`paper-compile`/`render-figures` 为确定性平台实现（subprocess 编排），ARIS 对应物是 prompt workflow 无可调用库——属 integration plan 允许的 sanctioned 薄实现，且报告记录 skill 哈希溯源 |
| Python 侧校验 | jsonschema | ✅ 与 TS 同一 schema 文件 | `worker/python/schema_validate.py` 读 `src/core/schema/schemas/*.json`，路径格式与 ajv 对齐；缺依赖降级为 stderr 提示+TS 读门禁兜底 |
| 文件遍历 | 无成熟包 | ⚠️ 4 处私有 walk，规则实质不同 | `scan.walk`（含 symlink、跳点目录）、`repository.walkRepository`（预算/信号）、`idea/seeds.walkRegularFiles`（排除 symlink 防逃逸）、`archive-extract.walkFiles`——语义差异是故意的，不构成重复实现；若第 5 处出现再抽共享 |
| 新依赖 | 许可证门禁 | ✅ 全部记录 | npm：ink(MIT)、ajv(MIT)、tree-kill(MIT)；pypi：jsonschema(MIT)、matplotlib(BSD-3) + contourpy(BSD-3，钉 1.3.1 因 1.4 要求 numpy≥2)；`pnpm release-check` 许可证 allowlist 通过 |

## 明确不做的事（负空间）

- 不复制 DSH Agent Loop / Session / subagent（`src/dsh/*` 仅 adapter + 插件）。
- 不建第二个任务数据库、第二个事件日志、第二个实验队列（experiment-queue 走同一 DB 的 wave 视图）。
- 不为 ARIS skill 重写 prompt 正文（全部 vendored + 哈希校验）。
- 不手写 JSON 解析器/进程树杀/终端渲染（jsonschema、tree-kill、ink）。

## 遗留项（按优先级）

1. JSON Schema 迁移剩余 ~20 个手写 validator（PROGRESS checkbox，结构层逐步外迁）。
2. `runtime/detect.ts`、`runtime/capacity.ts` 探针迁移到 `runProcess`（统一超时/树杀语义）。
3. `commands/render.ts`、`knowledge/wiki.ts` 的 helper spawn 加超时+树杀。
4. 第 5 处 walk 出现时再抽共享（现在抽会为 4 种不同规则造一个配置怪物）。

审查方式：后续每次新增依赖或新能力域，先在本文追加一行结论（append-only），并同步 DEPENDENCY_POLICY 的依赖记录。
