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
