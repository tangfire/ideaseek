# IdeaSeek ↔ ARIS 能力审计（Phase 4.5）

审计对象：ARIS 上游 `wanshuiyin/Auto-claude-code-research-in-sleep` @ `8f49392`（MIT）与 IdeaSeek 当前实现。
方法：两侧只读探查——ARIS 侧逐 skill 读取输入/输出/证据/失败/权限/预算/恢复契约；IdeaSeek 侧定位入口、契约、持久化与测试。
结论按 ADR-007/008/009 执行：能力必须存在，来源优先 ARIS；迁移执行 backend，保留 IdeaSeek 状态契约；迁移通过后删除重复默认实现。

## 总表

| 能力 | IdeaSeek 现状 | ARIS 对照 | 迁移结论 |
|---|---|---|---|
| idea discovery / idea creator | **占位**：候选生成不存在，卡片靠 `idea create --from-card`；rounds/fingerprint/机制门槛为确定性契约 | `idea-discovery`（539 行编排）+ `idea-creator`（613 行生成），evidence gate + `verify_papers.py` | 生成 backend 全量新增自 ARIS skill；IdeaCard/rounds/fingerprint 保留 |
| experiment plan / bridge | 确定性 `buildIdeaSpec`+`executeSpecRun`（子进程、失败分类、checkpoint、幂等），与 registry/门禁深度耦合 | `experiment-plan`（计划 markdown）+ `experiment-bridge`（跑实验、GT 纪律、tracker） | 计划层接 ARIS skill 产出 → 映射 ExperimentSpec；执行/队列/RunResult 保留 IdeaSeek（ARIS 无租约/准入语义） |
| ablation planner | 确定性 `deriveAblations`（机制链必要组件 + minimalExperiment），复用 spec 执行 | `ablation-planner`（LLM 双模型出计划表：what_it_tests/expected/priority/coverage） | proposal 生成迁 ARIS（更丰富、带预期结果）；矩阵绑定与执行保留 |
| novelty / prior-art | **占位**：仅卡片 schema 字段与指纹去重；`novelty_challenger` 角色声明未使用 | `novelty-check`（逐 claim 最近邻 + Score/10 + PROCEED/ABANDON，ABANDON 必须点名论文）+ `prior-art-search`（无 LLM，专利/NPL 表） | 新增 ARIS backend；输出写 Review 类 artifact + Decision，回填卡片 novelty 块 |
| fresh-context reviewer | **占位**：无 Review artifact/reviewer Decision；`review-only` 只是自治模式；最近似物是确定性 `verifyPaperEvidence` | `auto-review-loop`（1100 行：冷启动 reviewer、跨模型、REVIEW_STATE.json、gate 脚本、≥6 分且 ready/almost 才停） | 新增 fresh-context reviewer 适配器：DSH harness 承载 prompt，产物写独立 Review artifact + Decision/Event |
| experiment audit / integrity | 确定性 verdict ladder（`analyzeIdea` 7 类失败分类）、handoff gate、`explain` 哈希核验、leakage gate | `experiment-audit`（跨模型逐检查 file:line 引证 + EXPERIMENT_AUDIT.json）+ `integrity-forensics`（上游 pinned 扫描 + 门禁账本）+ `analyze-results`（本地统计） | 审计规则层接 ARIS（补跨模型 file:line 审查）；失败分类、handoff gate、确定性 ladder 保留（ARIS 无对应物） |

## 关键差异与保留理由

- **持久化**：ARIS 约定 `idea-stage/`、`refine-logs/`、`review-stage/`、`.aris/` 的 markdown/JSON 文件；IdeaSeek 的 ArtifactStore（hash+原子提交）、RunEvent、Decision、实验 registry 不可让渡——ARIS 产物必须作为 IdeaSeek Artifact 落库，文件目录只是投影。
- **执行语义**：ARIS skills 是给宿主 agent 读的纯 Markdown prompt（YAML frontmatter 声明 allowed-tools），依赖 `tools/` 下的确定性 gate 脚本（`run_state.py`、`idea_discovery_gate.py`、`review_gate.py`、`forensics_gate.py`，纯标准库）与 MCP reviewer 后端；缺失时 fail-closed（`BLOCKED`/`REVIEW_UNAVAILABLE`）。IdeaSeek 侧对应物是 HarnessAdapter.runTask + capability profile + 任务租约/重试/幂等——这是迁移必须包裹而不是替换的部分。
- **证据纪律**（两侧一致，作为 conformance 断言）：ARIS 要求逐字 reviewer 响应、`file:line` 引证、`verify_papers.py` 防编造、绝不虚构模型身份；IdeaSeek 要求证据定位、hash 绑定、脱敏、Decision 审计。
- **预算/恢复**：ARIS 用 `MAX_ROUNDS`/`PILOT_MAX_HOURS` 等常量与文件级 resume（`REVIEW_STATE.json`）；IdeaSeek 用任务租约、checkpoint、幂等提交。迁移后预算以 IdeaSeek 任务 budget 为准，ARIS 常量作为 prompt 内约束保留。
- **许可证**：ARIS MIT（© 2026 wanshuiyin）。vendored 文件见 `aris-skills/`（NOTICE 记录来源 commit），manifest SHA-256 校验（`ideaseek aris`）。

## 每项迁移的 conformance 必测路径

1. **成功路径**：固定输入 → skill 渲染 → harness 输出 → 契约校验（IdeaCard/Spec/…）→ Artifact+RunEvent 落库 → CLI/REPL 可读。
2. **坏输出**：JSON 缺失/schema 违规 → 任务失败带分类，不写半成品卡片。
3. **额度/权限**：`HarnessBlockError`（QUOTA/AUTH/NETWORK）→ run 停靠、attempt 不烧、恢复后续跑。
4. **取消/重启**：任务取消与进程重启后幂等（同 idempotencyKey 不重复产出）。
5. **skill 完整性**：vendored 文件被篡改 → 拒绝加载（SKILL_TAMPERED），不执行。
6. **删除旧默认入口**：迁移后旧的重复生成/计划/审查入口移除，历史 artifact/run/Decision 保持可读。

## 技能清单比对（2026-11-18 实测）

来源两侧都只读枚举，不采信任何"应当已接入"的说法：

| 口径 | 数量 | 依据 |
|---|---|---|
| 上游含 SKILL.md 的 skill 目录 | 87（另有 4 个无 SKILL.md 的 references/后端目录） | `D:\aris/skills/`，HEAD `8f49392`（与 manifest pin 一致，工作树干净） |
| 已 vendoring 且哈希入 manifest | 26 个 skill 目录、63 个内容文件 | `aris-skills/skills/`、`src/aris/manifest.ts:VENDORED_FILES` |
| 本次之前 `VENDORED_SKILLS` 登记 | 21 | 同名清单；差额 5 个（citation-crosscheck、figure-spec、overleaf-sync、paper-claim-audit、result-to-claim）文件已校验但 `loadArisSkill()` 直接拒绝加载 |

那 5 个"已入库未登记"是本节存在的理由：`aris` 当时报"21 skills, integrity: all files match"——对哈希是真话，对覆盖面是漏报；`paper diagram` 用的确定性渲染器正属于被拒的 figure-spec。修法是登记，不是重新抓取；tests/aris-skill.test.ts 新增双向平价断言（清单=磁盘、每个登记项都能加载）。

未 vendoring 的 61 个按与本项目的关系分组：

- **可能相关（29）**：run-experiment、training-check、dse-loop、experiment-queue、research-pipeline、research-lit、research-review、research-refine(+pipeline)、resubmit-pipeline、research-implement-feature、citation-audit、paper-writing、paper-illustration(+image2)、paper-poster(+html)、mermaid-diagram、figure-description、kill-argument、meta-apply、meta-optimize、specification-writing、writing-systems-papers、system-profile、slides-polish、idea-discovery-robot、auto-paper-improvement-loop 等。判断依据是它覆盖的动作 IdeaSeek 是否已有契约：多数已被确定性实现或 DSH 会话覆盖，缺的是"上游编排细节更丰富"，不是能力缺失。
- **不相关/重复（32）**：patent-*(5)、claims-drafting、embodiment-description、invention-structuring、jurisdiction-format（专利线）；各检索/算力/通知适配器（arxiv、openalex、semantic-scholar、exa-search、firecrawl-search、gemini-search、deepxiv、keenable-search、qzcli、vast-gpu、serverless-modal、feishu-notify、web-debug-search…）；auto-review-loop-llm/-minimax（已 vendored 同名的后端变体）；proof-*、lean-formalize、formula-derivation（形式化线）；interview-cheatsheet、pixel-art。

已登记 skill 的实际接线（`loadArisSkill` 调用点）：idea-creator `src/commands/idea.ts:724`、ablation-planner `:925`、novelty-check+prior-art-search `:1128/1129`、integrity-forensics `:1715`、experiment-plan `src/commands/experiment.ts:334` 与 `src/worker/experiment-handlers.ts:68`、paper-plan `src/commands/paper.ts:180`、paper-figure `:401/:939`、paper-write `:594`、paper-compile `:769`、rebuttal/paper-slides/paper-talk 经 `ENGAGEMENT_META`（`:1423-1430`）在 `:1455`、auto-review-loop/experiment-audit 经 `SKILL_BY_KIND`（`src/commands/review/review.ts:123-126`，`:567`）、analyze-results `src/idea/analysis-agent.ts:110`；脚本型复用：render-html `src/commands/render.ts:159`、research_wiki.py `src/knowledge/wiki.ts:290`、figure_renderer.py `src/paper/diagram.ts:71`。

**登记但零调用者（本轮仍未接）**：experiment-bridge、idea-discovery、monitor-experiment、overleaf-sync、paper-claim-audit、result-to-claim、citation-crosscheck（含 `scripts/cx_verify.py`）、research-wiki 的 SKILL.md 正文。其中 result-to-claim / paper-claim-audit 的同名能力由平台确定性实现（`ideaseek idea result-to-claim|claim-audit`），skill 正文是提示词参考而非执行路径；citation-crosscheck 需要"双盲+联网重取+第三方向字段 diff"的多 agent 会话，属尚未接入的真实缺口（不是遗漏的接线）。

### figure / compile 双实现结论

- figure：`src/paper/figure.ts`（模型出 matplotlib 脚本，只产计划不执行，且已把结构图明确让给确定性路线 `:308`）与 `src/paper/diagram.ts`（vendored figure-spec 的 JSON→SVG 确定性渲染，命令 `paper diagram`）**按产出类型互斥**，共用一个下游：`src/paper/place-figures.ts` 同时读 `figure-render.json` 与 `diagram-render.json`。因此不是两套实现，而是一条链的两个入口；剩余环境约束：graphicx 只能嵌 pdf/png/jpg，本机无 SVG→PDF 转换器（Windows 的 `convert` 是磁盘工具），故 SVG 产物在放置阶段报 SKIP 并给原因，而不是让 latex 在三层之外失败。
- compile：LaTeX 引擎路径只有一条（`src/paper/compile.ts`：latexmk/pdflatex，模板取自 vendored `paper-write/templates`）；`render-figures.ts` 只调 `pdftoppm` 做栅格化，`overleaf.ts` 只打印构建提示，均不构成第二实现。唯一"模型写+平台装配"重叠的是模板本身，属 integration plan 允许的 sanctioned 薄实现。
