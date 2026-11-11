# IdeaSeek 开发进度

这是后续开发 Agent 必须持续更新的进度文件。完成一个可验证模块后，把对应 `[ ]` 改为 `[x]`，填写 commit、测试和已知限制；未完成或只有空壳的模块保持 `[ ]`。不要为了看起来完整提前打勾。

## 当前主线

当前主线按优先级推进：

```text
Phase 4：Comparison 复现与统一评测
→ Phase 4.5：ARIS P0 能力迁移与 conformance
→ Phase 5：Idea 生成与实验闭环
→ Phase 6：领域无关引擎验证
→ Phase 7：产品硬化与长任务能力
→ Phase 8：发布与文档
```

领域插件、向量检索、多 GPU 和其他方向扩展不是 Phase 4/5 的前置条件。模块交付记录是 append-only 历史；顶部 checkbox 是当前状态的唯一来源。

## Phase 0：基础运行与可恢复性

目标：让项目、任务、artifact、事件和 checkpoint 在进程/机器中断后可恢复。

- [x] `ideaseek init` 幂等创建项目目录和模板
- [x] `ideaseek start` 小白用户一键入口和规模自适应策略
- [x] `ideaseek setup/doctor/config explain`
- [x] 自动检测 Python/Node/容器/CUDA/GPU/磁盘
- [x] `scan/intake/organize` 与 InputManifest
- [ ] 常见压缩包扫描、安全解压、成员 manifest 和 `ARCHIVE_BLOCKED` 处理
- [x] starter/standard/research 运行策略和报告措辞
- [x] 配置 schema、迁移和 ResolvedConfig 快照
- [x] Workflow DB 与 artifact store 接口
- [x] Task lease、heartbeat、重试、取消和幂等提交
- [x] RunEvent 持久化、`status/next`
- [x] 后台 supervisor、`attach/watch/events`
- [x] `pause/resume/continue/cancel`
- [x] 故障注入和 checkpoint 恢复

## Phase 1：DSH Runtime 与 Agent 能力

目标：接入 DSH 的 provider、Agent、Session、Tool、Subagent 和 capability profile，不复制 DSH Agent Loop。

- [x] 固定 DSH commit/包版本和兼容性测试
- [x] `HarnessAdapter`
- [x] Cordis plugins/bundles/profile 加载
- [x] 模型 provider、额度耗尽和凭据恢复
- [x] Agent capability profiles
- [x] Tool schemas、权限和审计事件
- [x] 假 Paper Extractor 端到端任务
- [x] fast/balanced/deep/deterministic 模型路由和按角色覆盖

## Phase 1.5：CLI 交互与可观察性

目标：让用户能实时观察、控制和恢复长期科研任务。

- [x] IdeaSeek 启动 banner 和窄终端 fallback
- [x] `ideaseek ›` 交互提示符与基础 slash 命令
- [x] 论文、comparison、idea、实验的实时事件摘要
- [x] `attach/watch/events` 事件回放与实时跟随
- [x] protocol/experiment/权限审批交互
- [x] `pause/resume/continue/cancel` 交互反馈
- [x] `--plain` 和 `--json` 输出
- [ ] TUI 应用壳：备用屏幕、固定输入区、事件 pane 和 footer
- [ ] command palette 原地过滤，不滚屏不重复 prompt
- [x] 任务详情、脱敏日志和错误解释
- [x] 断线重连、终端尺寸变化和后台 supervisor 状态显示
- [x] Research/Agent 模式切换、权限摘要和 DSH 复用

## Phase 2：论文知识与证据

目标：把论文变成可检索、可引用、可增量复用的研究知识。

- [x] PDF/LaTeX/OCR/表格/图表解析
- [x] PaperCard schema 和证据定位
- [x] 去重、全文/向量检索和增量处理
- [x] Paper Extractor 并行 map 阶段
- [x] Evidence Checker
- [x] 主题综合、机制库和研究地图
- [x] 论文 gold set 回归
- [ ] 图像/曲线视觉理解与低置信度回退核验

## Phase 3：数据画像与实验协议

目标：从论文、comparison 代码和用户数据自动生成可审查的实验协议。

- [x] Dataset Analyst 和 dataset card
- [x] Protocol Synthesis Agent
- [x] Leakage/Validity Checker
- [x] ExperimentalProtocolProposal schema
- [x] 用户确认和 protocol lock
- [x] Scenario Planner 和实验组合 L0–L4
- [x] DatasetSlice `smoke/quick/standard`、handoff manifest 和晋级规则
- [x] 数据分布保持、客户端/域/主体边界和泄漏检查

## Phase 4：Comparison 复现与统一评测

目标：让 comparison 可以被导入、修复、重实现、运行并和 idea 在同一协议下比较。

- [x] comparison manifest 与 required 状态
- [x] 用户仓库导入和 upstream/worktree 隔离
- [x] 官方代码定位和许可证记录
- [x] Baseline Repair Agent
- [x] Baseline Reproduction Agent
- [x] 统一 ExperimentSpec/RunResult
- [x] 所有 required comparison 门槛
- [ ] 任意结构代码仓库的 Codebase Analyst、入口发现和 wrapper/smoke 流程

## Phase 4.5A：ARIS P0 科研质量能力

目标：优先复用 ARIS 已有的成熟科研 workflow；IdeaSeek 负责把它们接入自己的 Artifact、ExperimentSpec、RunEvent、Decision 和 checkpoint，而不是重写同类能力。

- [x] ARIS skill/plugin adapter 和版本/许可证 manifest
- [x] `idea-discovery`/`idea-creator` 接入 IdeaCard/IdeationRound
- [x] `experiment-plan`/`experiment-bridge` 接入 ExperimentSpec/RunResult
- [x] `ablation-planner` 接入机制链和消融矩阵
- [ ] `novelty-check`/`prior-art-search` 接入 PaperCard 和 evidence
- [ ] fresh-context independent reviewer 接入 Review artifact/Decision
- [ ] `experiment-audit`/integrity workflow 接入结果门禁
- [ ] ARIS skill 失败时的回退、权限和 checkpoint 测试
- [x] 审计 IdeaSeek 已有同类实现与 ARIS 能力差异
- [ ] 将更成熟的 idea/experiment/ablation/review/audit backend 迁移到 ARIS
- [ ] 旧重复实现降级为兼容 fallback 或移除默认入口
- [ ] ARIS capability conformance/regression tests
- [ ] ARIS 迁移通过后删除旧重复实现、入口和重复配置

## Phase 4.5B：ARIS P1 研究记忆与长任务增强

- [ ] research-wiki：Paper/Idea/Experiment/Claim 图谱和 typed edges
- [ ] render-html：IDEA_REPORT、review、wiki 和审计 artifact 阅读视图
- [ ] watchdog：只检测 stalled/dead/stale，不做质量裁决
- [ ] experiment-queue：wave、depends_on、OOM retry、stale cleanup 和公平排队
- [ ] monitor-experiment：心跳、日志、资源和等待原因
- [ ] session recovery：跨会话恢复上下文摘要和 artifact 引用

## Phase 4.5C：ARIS P2 论文与发表交付

- [ ] paper-claim-audit 和 citation-crosscheck
- [ ] integrity-forensics
- [ ] Overleaf/LaTeX paper-write workflow
- [ ] rebuttal、paper slides 和 talk workflow

## Phase 5：Idea 生成与实验闭环

目标：让 idea 有机制、有独立代码、能并行 quick/standard 验证，并能根据结果修订或分叉。

- [ ] Mechanism Analyst、Idea Generator、Research Discussant
- [ ] Novelty Challenger、Synthesis Lead
- [x] IdeaCard 机制链和 `DRAFT_COMPOSITION` 门槛
- [x] 独立 idea workspace 和代码版本
- [x] Code Implementer、smoke test、静态检查
- [x] GPU Capacity Planner 和多 idea 并行
- [x] 主实验、消融、失败分类和 Result Analyst
- [x] Idea 版本迭代、否证和新 idea 分支
- [x] 结果/报告/复现清单
- [x] guided/autonomous/review-only 自动化策略和科学门槛

## Phase 6：领域无关引擎验证

目标：用真实研究材料验证同一套核心引擎可以从论文、comparison 和数据自动设计协议、探索 idea 并交付 handoff。联邦学习模型异构只是当前验收样例，不是产品支持范围的上限。

- [x] 接入真实 FL 数据集并生成 dataset manifest
- [x] 生成客户端/模型异构实验协议并通过泄漏门禁
- [x] 在代表性数据切片上验证 protocol lock
- [x] 完成 required comparison 的 quick smoke/评测
- [x] 运行一个 idea 的机制验证、关键消融和结果反馈
- [x] 建立该方向的人工 gold set 和回归样例
- [ ] 生成 `HANDOFF_READY` 级别的代码、配置和复现包
- [ ] 用第二个不同任务族做领域无关回归验证

## Phase 7：产品硬化与长任务能力

目标：让真实用户可以长期、低风险、可解释地使用 IdeaSeek。

- [ ] ResearchRun 跨 idea 版本/多轮实验的持久化编排
- [x] ExperimentRunner 训练内部 checkpoint/resume capability 和兼容校验
- [ ] stale heartbeat、磁盘阈值、备份失败和长期预算告警
- [ ] 长周期 soak test（加速时钟 CI + 发布前真实运行）
- [x] protocol/experiment/权限审批交互
- [x] 自然语言 REPL 与高影响操作确认
- [ ] fast/balanced/deep/deterministic 模型路由
- [x] 用户级/项目级配置、多项目注册和项目锁
- [ ] cleanup/archive/export、通知和反馈入口
- [x] IdeationRound 多轮 idea、旧候选去重和用户反馈回流
- [ ] `incoming/ideas/<name>/` 投递、扫描、intake 确认和已有 Idea 改进闭环
- [ ] USER_JOURNEY_ACCEPTANCE.md 的 Journey A–H 验收
- [ ] Application/domain/adapter 分层硬化与 composition root
- [ ] Build-vs-reuse 审查：优先接入 DSH/ARIS，避免重复实现
- [ ] `HANDOFF_READY` 后 Full Research/Publication 模式、数据下载审批和 full-run 隔离
- [ ] 全量图表、claim audit、论文草稿和独立 reviewer 交付链
- [ ] Overleaf 兼容 LaTeX 工程、BibTeX、图表源数据和 provenance 导出

## Phase 8：发布与文档

目标：让新用户能安装、学习、升级、恢复和复现。

- [ ] README Quickstart 与 USER_GUIDE 从零机器验证
- [ ] 文档站分层、搜索和版本发布流程
- [ ] npm CLI/package 发布和版本校验
- [ ] 一键安装/卸载和 `ideaseek doctor`
- [ ] Linux 安装包和服务器部署验证
- [ ] Windows/WSL2 使用路径验证
- [ ] 回归集、依赖、许可证和 secret 检查
- [ ] 备份恢复演练、版本迁移和回滚

## 可选扩展 Backlog

这些项目按真实需求启用，不是核心科研闭环的前置条件：

- [ ] 可选插件 SDK、安装/启用/doctor 和权限 manifest
- [ ] 多 GPU/CPU/内存资源计划和本地模型推理服务增强
- [ ] 多数据集/多场景实验组合扩展
- [ ] 用户/实验室自定义 parser、split validator、metric provider 或 experiment adapter
- [ ] 其他研究方向的回归验证和专用插件
- [ ] P0 capability：idea discovery/idea creator（优先复用 ARIS）
- [ ] P0 capability：experiment bridge（优先复用 ARIS）
- [ ] P0 capability：ablation planner（优先复用 ARIS）
- [ ] P0 capability：novelty check + fresh-context independent reviewer（优先复用 ARIS）
- [ ] P0 capability：experiment audit/integrity（优先复用 ARIS）
- [ ] P0 capability：selectable fresh-context reviewer 和 result-to-claim gate
- [ ] P1 capability：research wiki 和 HTML artifact renderer（优先复用 ARIS）
- [ ] P1 capability：watchdog/experiment queue/session recovery workflow
- [ ] P2 capability：claim/citation audit、paper writing/rebuttal/slides workflow
- [ ] Dataset Discovery Agent、来源/许可证/置信度和用户授权接入
## 模块交付记录

每个完成模块追加一行：

```text
YYYY-MM-DD | 模块 | commit | 测试命令/结果 | 已知限制 | 下一依赖
```

```text
2026-11-10 | Phase 0 可恢复垂直切片（init/status/next/events、Workflow DB、lease/heartbeat/重试/取消/幂等两阶段提交、RunEvent 回放、Artifact Store hash+原子提交、pause/resume/continue/cancel、假 Worker、故障注入与重启恢复） | 07f3cae | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 7 files / 50 tests passed（含 Worker 崩溃、重复提交、租约过期、输出写入中断、进程重启、quota 阻塞、CLI e2e 退出码） | Windows 下 SIGINT 无法投递给子进程，Ctrl-C 语义只做了进程内测试；后台 supervisor/attach/watch 未实现；scan/intake/organize、setup/doctor、start 未实现；配置无迁移器；DSH 未接入 | 下一模块：ideaseek setup/doctor/config explain + 自动环境检测（依赖本切片的 config 抽象）
2026-11-10 | Phase 0 setup/doctor/config explain、环境自动检测（Node/Python/容器/GPU+CUDA/磁盘）、配置 schema 严格校验与 config_version 迁移、ResolvedConfig run 快照 | 306d13a | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 10 files / 69 tests passed（含 schema/迁移单测、探针超时/ENOENT、setup 幂等、坏配置下 run/worker 拒绝与 doctor/next 退出码） | 探测均为本地只读，无网络探测；凭据检查占位（Phase 1 接 DSH provider）；setup 规范化会丢弃 yaml 注释（先备份） | 下一模块：scan/intake/organize 与 InputManifest（依赖 init/paths 抽象）
```
2026-11-10 | Phase 0 scan/intake/organize 与 InputManifest（扩展名+根目录分类、内容哈希去重、同名/同目录候选分组、增量哈希复用、平台索引 symlink/copy 与 provenance） | d629fcd | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 12 files / 77 tests passed（含 .research/ideas 排除、organize 幂等与占用槽位保护、CLI e2e 退出码） | 分类为无 PDF 解析的启发式（parser ideaseek-scan-1）；分组全部 needsConfirmation（无确认交互流）；Windows 无符号链接权限时回退副本 | 下一模块：starter/standard/research 运行策略与 report 措辞
2026-11-10 | Phase 0 运行策略（auto 规模自适应 starter/standard/research + countInputs 探测）与 ideaseek report 策略措辞 | bea80df | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 14 files / 86 tests passed（策略阈值、措辞覆盖、显式 mode 覆盖 e2e） | 报告仅含持久化事实（Phase 0 无模型结论）；措辞为固定模板 | 下一模块：ideaseek start 一键入口
2026-11-10 | Phase 0 ideaseek start 一键入口（initializeProject/performSetup/performScan 复用抽取 + 问题持久化 + 环境摘要 + 下一步向导） | 30f69ee | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 15 files / 88 tests passed（bootstrap/幂等/问题保留/有输入后 next 切换） | start 不自动执行 run（Phase 0 受限语义，执行仍显式） | 下一模块：后台 supervisor、attach/watch/events
2026-11-10 | Phase 0 后台 supervisor（run --detach + daemon.json 心跳）、attach/watch 实时事件流（DB 轮询回放+跟随）、status supervisor 状态 | 473b792 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 17 files / 97 tests passed（follow 回放/signal/worker-lost、detach→完成→attach 回放 e2e、watch 退出码、pause 关停 daemon） | attach/watch 基于 DB 轮询（默认300ms）而非推送；Windows 无法向子进程投 SIGINT（watch/attach 的 Ctrl-C 语义仅进程内测试）；supervise 为内部命令 | Phase 0 全部 checkbox 完成；下一阶段 Phase 1：HarnessAdapter + 固定 DSH commit
2026-11-10 | Phase 1 起步：runtime-lock.json 固定 DSH commit fcc0ad46 + 兼容性测试、HarnessAdapter 契约（结构化 runTask/类型化 block/脱敏事件）、FakeHarnessAdapter、paper.extract 假 Paper Extractor 端到端（quota 恢复/永久失败/缺 harness 路径）、CLI --paper/--harness | f57517e | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 19 files / 108 tests passed | DSH 真实适配（SDK/Cordis 嵌入）与 provider/profile/tool-schema 尚未接入，--harness dsh 明确报错；凭据仍为占位 | 下一模块：读取 DSH 公开 API 报告 → DshHarnessAdapter（SDK 或 in-process Cordis）
2026-11-10 | Phase 1 DshHarnessAdapter（@deepseek-ai/dsh-sdk-client 0.2.2-rc.1 子进程边界、稳定 LlmFailure 码映射、JSON 抽取、真实 keyless spawn 测试）| d17c203 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 20 files / 117 tests | DSH 无 cancel RPC：超时即关闭 runtime 重试；带真实 key 的模型调用未测（无凭据，e2e 自跳过） | 下一模块：Cordis 插件与 capability profile
2026-11-10 | Phase 1 capability profile + 研究工具插件 + 审计（generated ideaseek.cordis.yml：research-tools、preset registry 默认 ideaseek-extractor、工具 allowlist 子插件；DSH_PERMISSION_MODE=read-only + project_read 路径守卫；papercard 持久化 toolCalls/sessionId + harness_tool_call RunEvent；doctor 显示 DSH pin 与凭据存在性）| 26de559 + 79c1e7c | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 21 files / 125 tests（含 dsh --dump-config 组合验证与真实 keyless spawn 加载 patch）| 多角色可见性目前只有 extractor allowlist（第二角色随 Phase 2 综合角色落地）；审批流未启用（Phase 1 提取不调用需审批的工具） | Phase 1 checkbox 全部完成；带 key 的端到端模型调用留给用户提供凭据后验证
2026-11-10 | Phase 2 起步：PaperCard 契约+校验（claims 必须带证据定位）、Python pypdf worker（严格 JSON 协议/稳定错误码/夹具 PDF 生成器/5 unittest）、TS 桥接、paper.parse 任务与 run --paper PDF 链（parse→extract 保留 [page N] 标记）、task_result 事件 | 237ea54 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 23 files/135 vitest + 5 python 全过（含真实 PDF 链 e2e）| LaTeX/OCR/表格图表解析未做；真实抽取需模型凭据（fake harness 跑通链路） | 下一模块：FTS 全文检索
2026-11-10 | Phase 2 FTS5 索引与检索：迁移 v2（paper_index+paper_fts）、按 sourceHash+parser 的增量 refresh、来源替换代际清理、查询消毒（运算符注入中和）、ideaseek search（页级命中+snippet+--reindex/--no-index）| 99e8e26 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 24 files/141 vitest + 5 python 全过（含检索 CLI e2e）| 向量检索未做（需模型/embedding）；knowledge_search DSH 工具封装待 Evidence Checker 一起落地 | 下一模块：Evidence Checker（确定性引文核验）
2026-11-10 | Phase 2 Evidence Checker（确定性层）：verifyPaperEvidence 引文/页码/哈希绑定核验、paper.verify 任务链、evidence_verdict 事件、FakeHarness 输出合规 PaperCard、extract 平台盖章 document_hash/paper_id | cd7959e | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 25 files/150 vitest + 5 python 全过（checker 判定矩阵9例 + 双链 e2e verdict pass）| 判定仅覆盖确定性部分（结构/引文/绑定）；语义级核验与真实抽取需模型凭据 | 下一模块：knowledge_search DSH 工具封装或 ingest 并行解析入口（均可无凭据推进）
2026-11-10 | Phase 2 knowledge_search DSH 工具（CLI 子进程查询 FTS 索引、单写者协议、解析器 allowlist 扩展为 project_read+knowledge_search）| e5297f4 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 26 files/156 vitest + 5 python 全过 | DSH 子进程不直连 DB（经 ideaseek search --json）；工具真实被模型调用的会话级验证需凭据 | 下一模块：ingest 并行解析入口（无凭据）
2026-11-10 | Phase 2 ideaseek ingest（扫描→按内容哈希跨 run 增量分派 paper.parse→内联执行→FTS 刷新→search 提示；空转 no-op 不建 run）+ make-fixture --marker | 3d0117a | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 27 files/161 vitest + 5 python 全过 | 相同字节的重复 PDF 按内容寻址只索引一次（预期语义）；抽取/综合仍需模型凭据 | Phase 2 可无凭据推进的模块已完成；余项需 DEEPSEEK_API_KEY 或用户语料（见阶段汇报）
2026-11-10 | Phase 2 Evidence Checker checkbox 完成确认（确定性核验层已交付并测试；语义级复核增强仍需模型）| cd7959e | 同上 | 数值-单位逐项对照依赖抽取带 quote；无 quote 的页码定位记为 weak | 外部依赖：真实抽取需 DEEPSEEK_API_KEY，gold set 需用户语料
2026-11-10 | Phase 3 起步：DatasetSlice 契约+确定性种子切分（smoke/quick/standard）、CSV 解析/切片/原子写出与可重建哈希、dataset_slice 注册表（迁移 v3）、data slices/describe CLI | 5325888 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 28 files/171 vitest + 5 python 全过 | 行级切分为 rule v1（组/时间边界由领域适配器提供，limits 已记录）；Dataset Analyst 完整卡片与协议综合待后续 | 下一模块：ExperimentalProtocolProposal 契约与校验
2026-11-10 | Phase 3 ExperimentalProtocolProposal 契约+校验（sourced 字段/来源枚举/置信度/低置信确认清单）+ 协议锁定（哈希+confirmedBy，迁移 v4）+ ideaseek confirm protocol | 89a9d51 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 29 files/180 vitest + 5 python 全过 | 协议「生成」（Protocol Synthesis Agent）需模型凭据；本模块负责契约、校验与锁定 | 下一模块：handoff manifest 或 Leakage/Validity 确定性检查
2026-11-10 | Phase 3 Leakage/Validity 确定性检查（单快照/哈希溯源/行数边界 blocker、种子统一/嵌套 warning-info、组时间边界与协议规则 pending）并接入 confirm protocol 门禁 | d8ef880 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 30 files/186 vitest + 5 python 全过 | 语义级泄漏检查（标签/时间因果）需协议与领域适配器，已作为 pending 明示 | 下一模块：Dataset Analyst 确定性数据画像
2026-11-10 | Phase 3 Dataset Analyst 确定性画像与 dataset card（profileCsv：缺失/重复/常量列/数值类型/label 候选 0.6 置信需确认/许可线索；knowledge/dataset-card.json+md；data describe 升级）| f6cbd07 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 31 files/190 vitest + 5 python 全过 | 仅 CSV 画像；label 语义与切分含义按契约留待用户确认；LLM 增强版分析师属于凭据解锁项 | 下一模块：Scenario/Portfolio 契约或 handoff manifest
2026-11-10 | Phase 3 Scenario/Portfolio L0–L4 契约+校验（等级枚举/重复/稳定性种子≥3/L4 外部数据门槛/晋级与停止规则）+ buildDefaultPortfolio 确定性默认组合 | a90e0de | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 32 files/196 vitest + 5 python 全过 | Experiment Designer LLM 生成与实际实验消费属凭据/Phase5 依赖；晋级执行需 idea workspace | 下一模块：handoff manifest 或收口汇报
2026-11-10 | Phase 3 handoff manifest 契约（slice 引用+环境+命令+provenance+不执行全量训练的边界声明）与 buildHandoff 组装器 | 7a084e0 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 33 files/200 vitest + 5 python 全过 | experiment handoff CLI 命令待 idea workspace（Phase 5）接线 | Phase 3 无凭据可交付项完成
2026-11-10 | Phase 3 checkbox 确认：Leakage/Validity Checker（确定性层+pending 明示）、ProtocolProposal schema、协议确认与锁定、Scenario L0–L4、DatasetSlice+handoff+晋级规则（CLI promote/handoff 待 Phase 5 接线）| d8ef880+89a9d51+a90e0de+5325888+7a084e0 | 各模块门禁全绿（33 files/200 vitest+5 python）| Protocol Synthesis LLM 生成需凭据；语义级检查需适配器 | 剩余：数据分布保持检查（可做）与首发领域验证（需语料）
2026-11-10 | Phase 3 数据分布保持检查（类别 top-share 漂移 warning/blocker、数值 σ 均值漂移、slice.distributionCheck 记录与构建时打印）| 22b4938 | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 34 files/205 vitest + 5 python 全过 | 客户端/域/主体边界对通用 CSV 以 pending 明示（领域适配器负责）；标签无关漂移检测 | Phase 3 剩余仅凭据依赖项（Protocol Synthesis LLM）与语料依赖项（首发领域 gold set）
2026-11-10 | 真实语料+真实凭据验证批次：.env 安全加载（679cdc3）、74 篇增量扫描/解析全通+坏PDF失败隔离（2af9b9a）、capability guard 关闭原生工具逃逸+keyed 真实模型集成测试（3025170）、引文排版归一化（508f32e）| 全部见各 commit | 门禁：pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 36 files/217 vitest+5 python（含真实模型 keyed 测试）；真实证据核验13/13与8/8 pass；增量证据：冷扫描reused=0→热30→wave2 new44/skip30→74/74 indexed | 论文/数据/.env 均被 gitignore 排除且 staged 无 secret；并行 map、向量检索、LaTeX/OCR、gold set 仍未做 | 下一模块：Paper Extractor 并行 map 阶段（extract --parallel 批量抽取）
2026-11-10 | Phase 2 Paper Extractor 并行 map 阶段：ideaseek extract（增量选择/extract+verify 链/K 个并行 worker 子进程/超时与退出码）、handler 跨 run 全局 parsed 复用 | ac64bfe | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 37 files/222 vitest+5 python 全过（fake 并行 e2e + keyed 真实模型并行 e2e，2 篇/K=2/零失败）| 并发上限钳制4（API/内存保护）；全量 74 篇真实抽取由 --limit 分批执行以控成本 | 下一模块：论文 gold set 回归（语料已就位）或向量检索
2026-11-10 | Phase 2 gold set 回归：sampleSources+evaluateSource+aggregate（覆盖率/卡片有效/证据支持/页定位/哈希绑定/判定通过率）+ ideaseek evaluate + knowledge/goldset-report.json | 80182b1+0454b79+2edc576+timeout-fix | 门禁 38 files/230 vitest+5 python 全绿 | 真实校准（12 篇/seed42，真实模型）：coverage100% cardValid100% evidence89.5% pageAccuracy89.5% hashBinding100% verdictPass75% avgClaims8；3 篇存在未过核验引文（模型转述/页码归属），正是人工复核入口 knowledge/goldset-report.json；全语料74/74 已抽取+核验 | 下一模块：主题综合、机制库和研究地图（卡片已就绪，凭据已解锁）
2026-11-10 | Phase 2 主题综合/机制库/研究地图：确定性聚类+契约校验+可复用增量 synth.topic/synth.map 任务+ideaseek synthesize+paper-cards/syntheses/research-map 导出 | 8f02e55 | 门禁 39 files/238 vitest+5 python 全绿 | 真实模型在76卡语料上：4 主题+地图 5/5 任务完成，knowledge/research-map.md 含量化谱系/带引用冲突/证据空白（每条引 papers/*.pdf）| 机制库以 mechanisms[] 落在各主题综合中；剩余 Phase 2 项：LaTeX/OCR/表格解析与向量检索 | 下一模块：向量检索或 LaTeX 解析（均可无新凭据）
2026-11-10 | Phase 2 表格解析：pdfplumber tables 命令+extractTables 桥+paper.tables 任务+ingest --tables（增量、opt-in）| be5a3bc | 门禁 40 files/242 vitest+7 python 全绿；真实 FL 论文在管线内抽出2个表格 | OCR 仍缺 tesseract（环境阻塞）；LaTeX 源解析与向量检索待决策 | 下一模块：LaTeX 源解析（无阻塞）
2026-11-10 | Phase 2 LaTeX 源解析：parseLatex（注释/命令/章节/标题/转义）+paper.latex 任务（统一 parsed-paper 形状）+ingest .tex 增量 | d6bde51 | 门禁 41 files/248 vitest+7 python 全绿（含 .tex→FTS 检索 e2e）| OCR 仍缺 tesseract；向量检索待 embed 提供方决策 | Phase 2 可做项全部完成，剩 OCR（环境）与向量（架构决策）
2026-11-10 | Phase 2 OCR：worker ocr 命令（pypdfium2+rapidocr≤20页）+隔离 venv 锁定依赖（系统 onnxruntime 段错误→ort1.19.2 锁定）+paper.parse NO_TEXT_LAYER 自动回退（失败信息含 OCR 尝试证明）| 183e3f9 | 门禁 42 files/250 vitest+9 python 全绿（venv real OCR roundtrip + 无文本 PDF 永久标记）| 扫描件正向 e2e 依赖带图 fixture（现有夹具均为文本层）；OCR 每页1-3s 属 opt-in 成本 | 向量检索仍需 embed 提供方决策（DeepSeek 无 embeddings 端点，404 已验证）
2026-11-10 | checkbox「PDF/LaTeX/OCR/表格/图表解析」完成确认：PDF 文本(74/74)、LaTeX(paper.latex)、OCR(venv rapidocr 回退)、表格(pdfplumber opt-in)均落地并测试；图表的文本/题注已随页文本覆盖，图内数值提取属视觉模型扩展（未做，如实注明）| 汇总 2d4ee1d 系列 commit | 门禁 42 files/250 vitest+9 python | 该 checkbox 按用户规则（实现+测试+commit）打勾
2026-11-10 | Phase 3 Protocol Synthesis Agent：buildProtocolInput（语料+数据画像、无数据集时强制低置信标注）+protocol.propose 任务（内嵌 schema/平台盖章/校验门/哈希复用）+ ideaseek protocol propose 接入 confirm 锁定闭环 | b53340f | 门禁 43 files/254 vitest+9 python 全绿（propose→confirm→lock e2e + proposal-current 幂等）| 真实模型版协议提案可用 --harness dsh（伪输出已过校验器；真跑待数据集语义确认更有意义）| Phase 3 余：数据分布已做、领域验证需用户数据集
2026-11-10 | 真实模型协议闭环验证：protocol propose --harness dsh（1/1 完成）→ confirm --by researcher 锁定；指标带 paper-evidence 来源（accuracy↑/comm-rounds↓、conf 0.75-0.85）、基线取自语料真方法（FedAvg/FedProx/FedDF/FedMD/FedProto/FedGKT）、数据依赖字段被自动降为 agent-inference 低置信并生成5条用户确认项 | 代码同上（89a9d51 系列）| 无需新提交（真实运行验证）| Phase 3 仅余「首发领域验证+gold set（联邦学习）」——需用户提供 datasets/ 数据集与 comparison 代码
2026-11-10 | 外部只读数据集接入（用户决定1）：inputs.readonly_datasets + Python npz 联邦画像（全检查表）+ data describe dataset-manifest.json + 联邦切片规则 v2（选择清单、零拷贝）+ data slices 自动6切片 | 81311b0 | 门禁 44 files/261 vitest+9 python 全绿 | 真实 FedPF mnist 实测：20 clients/52,492 train/17,508 test、x=[N,1,28,28]f32、labels0-9、tvMean=0.7348（强 non-IID）、rootHash sha256:20da58b6…、只读指纹前后一致、staged 无数据文件 | research.yaml 仅含路径（已提交）；.npz 需 allow_pickle 已处理
2026-11-10 | 用户决定2落地：本地 embedding（fastembed0.9.1+MiniLM-L6-v2/Apache-2.0，共享缓存+指纹 manifest）、迁移v5向量表、增量嵌入、FTS-first RRF 混合检索+全失败回退、setup/doctor --install-embeddings、证据免责输出 | 591cb11 | 门禁 45 files/266 vitest+9 python 全绿 | 真实74篇：首搜嵌入1357页(8m13一次性)/hybrid融合40+40；复搜增量0嵌入3s；无外部 embedding API | Phase 2 checkbox 全部完成
2026-11-10 | Phase 4 起步：ComparisonMethod 契约+状态机（合法迁移/excluded·blocked·partial 必须带 reason）、迁移v6 comparison 注册表（upsert/get/list/transition+history）、匿名 git 导入器（GIT_TERMINAL_PROMPT=0、upstream 只读+worktree 隔离、commit/license 溯源、重复导入拒绝）、ideaseek comparison import/list/set-status/smoke（smoke 结果按状态机落库、method.yaml 同步导出） | 14aaedf | 门禁 46 files/281 vitest+9 python 全绿（含本地 git fixture 导入/隔离/状态机 e2e）| 官方代码自动定位（从论文找 repo）未做；smoke 默认 entry 为 `python --version` 占位；Baseline Repair/Reproduction Agent 未做 | 下一模块：官方代码定位与许可证记录或 Baseline Repair Agent
2026-11-10 | Phase 4 官方代码定位与许可证记录：确定性 repo URL 发现（paper_fts LIKE 预筛+归一化/保留 owner 过滤、comparison discover → knowledge/comparison-candidates.json）、comparison register 候选注册（不 clone、candidate 状态入状态机）、import 免 url 回退已注册 repo 并记录 candidate→accepted→source-resolved 跳跃历史、许可证读取+classifyLicense 分类（permissive/weak-copyleft/copyleft/unknown/none 入 repo.licenseKind） | 25752a1 | 门禁 46 files/289 vitest+9 python 全绿（URL 归一化/许可证分类/候选聚合/DB 发现/register→import 无 url 回退 e2e）| LLM 从实验表格发现候选（Phase 6）、GitHub API 元数据检索、许可证策略门禁（allowlist 拒绝）未做 | 下一模块：Baseline Repair Agent 或统一 ExperimentSpec/RunResult
2026-11-10 | Phase 4 Baseline Repair Agent：repair 引擎（失败分类7类、引号感知 entry 解析、日志脱敏、repair.json 逐轮原子落盘与中断恢复/续跑）、安全自动修复仅限 missing-dependency+requirements（worktree 内 venv+pip、轮次预算、无盲重试）、worktree diff 分类 none/environment/code-review（代码改动不自动接受、requiresConfirmation+状态停在 repairing 等用户确认）、ideaseek baseline repair CLI、状态纪律 implemented/blocked/smoke-tested→repairing→smoke-tested|blocked、method.yaml 同步 | 0dad7b0 | 门禁 47 files/314 vitest+9 python 全绿（25 个 baseline-repair 测试：分类矩阵/planFix/恢复续跑/预算/超时/6 条 CLI e2e 含 venv 多轮与代码确认门）| 自动修复不覆盖算法语义改动（按 plan 需用户确认）；venv 修复依赖本机 python 与 pip（e2e 用空 requirements 离线验证）；Baseline Reproduction Agent 与 LLM 诊断循环未做 | 下一模块：统一 ExperimentSpec/RunResult 或 Baseline Reproduction Agent
2026-11-10 | Phase 4 统一 ExperimentSpec/RunResult：spec.ts 契约+结构校验（指标方向/整数种子/失败必填类别/时间序）+键序无关 stableJson 与 computeSpecHash 版本身份、迁移v7 experiment 注册表（同哈希幂等重录、变更加分拒绝要求 bump version、result 每版本仅附加一次）、ideaseek experiment spec/result/list/show 全 --json | 272c7fb | 门禁 48 files/330 vitest+9 python 全绿（16 个实验契约测试：校验矩阵/哈希稳定性/版本幂等/附加一次/CLI 生命周期与全部失败退出码）| 与 idea workspace/实验执行的接线属 Phase 5；promote/handoff CLI 仍待 idea workspace；spec 文件由用户提供 JSON（平台不代写）| 下一模块：所有 required comparison 门槛 或 Baseline Reproduction Agent
2026-11-10 | Phase 1.5 CLI 交互与可观察性：裸 ideaseek（TTY→REPL/非TTY→提示/--json→状态+事件快照）、块 banner+窄终端[IS]回退+SIGWINCH 宽度跟踪、上下文头（project/run/stage/agents/papers/GPU/CPU/mem/supervisor）、16 个 slash 命令全部经子进程转发等价非交互 CLI（零业务逻辑复制）、唯一前缀+Tab 补全、串行行队列（piped 多行不超车）、attach --json 后台流（回放+实时跟随、quit/EOF 不取消 run、重连从 seq0 回放）、新命令 papers/logs/reject、confirm protocol 追加 approved decision 事件、显示层脱敏（core/redact 覆盖 status/events/stream/REPL）、全局 --plain/--json 改 positional options 保住子命令 flag 解析 | 4924216 | 门禁 49 files/346 vitest+9 python 全绿（16 个交互测试：help/未知命令、前缀+补全器、status/next、pause/resume、approval gate、plain 无 ANSI、回放+重连、plain/json 零 secret 泄露、logs）| TTY 专属路径（真实 Tab/彩色/resize 事件）在管道测试下只能单测覆盖；experiment/权限审批流待 Phase 5/权限模型落地（checkbox 保持未勾）；/ideas 为 Phase 5 占位提示 | 下一模块：所有 required comparison 门槛 或 Baseline Reproduction Agent
2026-11-10 | Phase 4 所有 required comparison 门槛：ideaseek comparison gate（required 方法须为 smoke-tested/evaluated/validated 或被带 succeeded/partial 结果的 ExperimentSpec 覆盖；excluded 带原因记 SKIP；reference-only 不阻塞；blocking 打印精确下一命令；exit 2 挡住 idea 生成）| f2ced0a | 门禁 49 files/350 vitest+9 python 全绿（4 条 gate e2e：空集通过、pending 失败→smoke-tested 通过、带原因排除+参考级忽略、experiment 结果覆盖、blocked 失败带下一命令提示）| 「探索模式」（无有效对照放行）未实现——需用户显式决策入口；合理性检查仅覆盖状态与结果存在性，指标阈值 sanity check 待协议指标落地 | Phase 4 仅余 Baseline Reproduction Agent（需论文-only 方法语料）
2026-11-11 | Phase 4 Baseline Reproduction Agent：reproduction blueprint 契约（paperExplicit 带引用/assumptions/missingDetails/confidence/algorithm 块，fail-fast 校验零副作用）、worktree 生成（git scaffold 空提交、无 upstream、绝不碰用户仓库、溯源 README）、验证阶梯 py_compile+import→check-data→check-metrics→有界 smoke（scale=smoke 不跑全量训练）、reproduction.json 逐阶段原子落盘与 in-progress 续跑、算法语义指纹（source+entry+data+metrics+hyperparams sha256）强制 --algorithm-modified --reason 并贯穿 method notes/README/gate 标注、成功走状态机到 smoke-tested 并自动挂 repro-<id> ExperimentSpec（指纹入 environment.notes、语义变化版本+1）+RunResult、失败按阶段分类落 blocked/repairing 带原因、official-code 方法拒绝指向 repair | e187ba6 | 门禁 50 files/361 vitest+9 python 全绿（11 条 reproduce 测试：成功+gate+spec、论文细节缺失、生成失败、依赖失败、数据接口失败+恢复、崩溃续跑、algorithm-modified 强制、official-code 拒绝）| blueprint 由 agent/用户提供（LLM 生成蓝图属凭据解锁项）；指标合理性仅校验存在与有限性，阈值 sanity 待协议指标落地 | Phase 4 checkbox 全部完成，进入 Phase 5 Idea 闭环
2026-11-11 | Phase 5 IdeaCard 机制链与 DRAFT_COMPOSITION 门槛：IdeaCard 完整契约（假设/带引用论文证据/矛盾/新颖性三元组/六类机制链+设计原则对应/最近邻对比带证据位置/组件必要性角色/竞争解释/边界条件/风险/最小实验/否证条件/预算/停止条件）、版本耦合（v1 parentVersion 必须 null、后续版本须整数父版本，假设变化新建 idea_id 记入契约注释）、机制门槛（缺任一链类别或≥2 组件无必要机制 → 强制 DRAFT_COMPOSITION；门槛失败却声称 CANDIDATE 为校验错误，实验队列不可入）、ideaseek idea validate [--require-candidate] [--json] | f801c9c | 门禁 51 files/373 vitest+9 python 全绿（12 条 idea-card 测试：schema 矩阵/版本耦合/门槛阻断/谎报候选拒绝/表面组合/CLI 校验+严格模式+坏文件）| LLM 生成 IdeaCard（Mechanism Analyst/Idea Generator 等）与讨论流程属凭据解锁项；idea 持久化与 workspace 随下一模块落地 | 下一模块：独立 idea workspace 和代码版本
2026-11-11 | Phase 5 独立 idea workspace 和代码版本：ideas/<id>/ 结构（idea.json 校验卡/idea.md 渲染/workspace.json 生命周期+历史+父子链/versions/ 每版记录/src·config·data·experiments/README 复现命令、仅 quick/standard）、生命周期状态机（PROPOSED→…→SUPPORTED|REJECTED|INVALID_RUN，REJECTED 必带原因）、工程/科学分离（revise --kind engineering 升版且同步卡版本、崩溃续跑补指针不产生 vN+2；--kind scientific 拒绝并指到 idea branch；branch 新 ideaId+parentIdeaId+父端 children）、checkpoint 绑定 idea_id+版本+src 内容 sha256（无嵌套 git、未变更幂等）、assertIdeaWorkspacePath 跨 idea/只读输入写入拒绝（含路径穿越）、data/manifest.json 输入哈希绑定与 verify 输入漂移/结构/版本链损坏检测、部分创建崩溃恢复（完整才 ALREADY_INITIALIZED）| e9e083c | 门禁 52 files/384 vitest+9 python 全绿（11 条 workspace 测试：完整结构、重复创建、幂等 checkpoint、输入变化、create/revise 崩溃续跑、工程vs科学分离、状态机+原因、链损坏、跨 idea 守卫）| 沙箱执行与 GPU 调度随 Code Implementer/Capacity Planner 落地；LLM 写卡仍属凭据解锁项 | 下一模块：Code Implementer、smoke test、静态检查
2026-11-11 | Phase 5 Code Implementer 门禁：idea scaffold（train/check_data/check_metrics/smoke/unittest/config/train.json/data/synthetic.csv 骨架，按卡 minimalExperiment 派生、绝不覆盖已有文件、幂等）、idea check 阶梯（static py_compile+config JSON→unit tests→data 接口→metrics 可算→smoke 微跑仅合成数据校验 {"metrics"} 对齐配置、全程无训练无 GPU）、共享失败分类+脱敏日志 .research/logs/idea-<id>-<phase>.log、experiments/check-report.json 绑定 ideaId+version+src 内容哈希、通过且 IMPLEMENTING 自动晋级 SMOKE_TESTED（实现错误保持 IMPLEMENTING 修复重查、smoke 缺失 exit0 带明确提示、可选阶段缺失显式 skip）| 250511c | 门禁 53 files/393 vitest+9 python 全绿（9 条 check 测试：幂等 scaffold、全通过+自动晋级、静态语法/坏 config 失败、单元依赖失败、数据接口失败、metrics 失败、smoke 缺失、版本绑定报告、未知 idea）| 真实实验执行与 GPU 调度待 ExperimentSpec 接线与 Capacity Planner；LLM 写码仍为凭据解锁项 | 下一模块：ExperimentSpec/RunResult 接线（idea 侧）
2026-11-11 | Phase 5 ExperimentSpec/RunResult 接线（idea 侧）：buildIdeaSpec（specId idea-<id>、comparisonIds 取最近邻、指标方向回填协议提案、dataSnapshotId 由输入清单哈希或 synthetic、seeds/预算取卡与 config、environment.notes 绑定 scale+idea-v+src 内容哈希+attempt、稳定 createdAt/version 参与哈希保证幂等）、idea experiment 门禁（须有当前通过的 check-report、状态 SMOKE_TESTED/RUNNING/ANALYZING、ANALYZING 改规格须走 NEEDS_REVISION 回路）、smoke/quick 有界执行（绝无全量训练）、{"metrics"} 解析校验、失败 RunResult 带分类（invalid-result/dependency/code/data/timeout/resource）、失败保持 RUNNING 可重试（attempt+1 新版本）、成功 RUNNING→ANALYZING、幂等成功重跑不执行、experiments/ 目录镜像（经 assertIdeaWorkspacePath 守卫）| 232ce21 | 门禁 54 files/398 vitest+9 python 全绿（5 条 experiment 测试：成功全链、幂等、无/过期 check 拒绝、quick 失败分类+重试版本递增、scale/生命周期纪律）| LLM 实验生成与消融矩阵属后续；GPU 执行待 Capacity Planner | 下一模块：GPU Capacity Planner
2026-11-11 | Phase 5 GPU Capacity Planner：runtime/capacity 探测（nvidia-smi CSV 逐卡 free/total/util、CPU 核数、空闲内存、磁盘）+ computeAdmission 准入计算（(createdAt,ideaId) 稳定序贪心、GPU 请求绑定 distinct 设备且须满足显存+headroom、CPU-only 预留核数与内存 headroom、用户上限 max_parallel_ideas、超额显式排队原因、binding constraints 汇总、绝不超额分配）、ideaseek capacity [--json]（就绪=SMOKE_TESTED 才计请求、config/train.json resources 读请求、knowledge/capacity-plan.json 审计落盘）、buildIdeaSpec.resources 从 config 接线（scaffold 默认 gpus0/mem1GiB）| 4e006a9 | 门禁 55 files/407 vitest+9 python 全绿（9 条 capacity 测试：用户上限/单卡过载拒/双卡 distinct 绑定/显存不足/内存 headroom/空计划/CLI 探测+计划文件/仅 SMOKE_TESTED 计入+resources 接线）| 多 idea 并行执行编排与运行时资源监控（OOM/温度/争用处置）未做；预算（max_gpu_hours）时间维度未纳入本版 | 下一模块：多 idea 并行（执行编排）
2026-11-11 | Phase 5 多 idea 并行：runReadyExperiments（发现 SMOKE_TESTED→capacity 准入（复用 probe+computeAdmission+max_parallel_ideas）→Promise.all 并发执行已准入实验、单 idea 异常隔离不拖垮兄弟、排队者原地不动）、ideaseek idea run-ready [--scale|--timeout|--json]（退出码反映已准入运行成败，排队不算失败）、ideaResourceRequest 抽共享（capacity 命令与并行运行器同一请求来源）| 91a3227 | 门禁 56 files/411 vitest+9 python 全绿（4 条并行测试：双 idea 并发+结果独立不串扰、max_parallel_ideas=1 排队与状态保持、空转 no-op、破坏性隔离 beta stale 不阻塞 alpha）| 运行中 OOM/温度/争用的实时资源监控与抢占未做（探测为计划期快照）；GPU 多卡真实并发受宿主硬件限制、单测以注入 probe 覆盖 | Phase 5 余：主实验/消融/Result Analyst、版本迭代与新 idea 分支流程化、handoff 复现包、guided 自动化策略
2026-11-11 | Phase 5 主实验/消融/失败分类/Result Analyst：deriveAblations 消融矩阵源自机制链（necessary-mechanism 组件逐个 w/o + 卡片声明消融、engineering 角色不消融、去重）、runAblations 每条消融独立 specId（idea-<id>-abl-*）绑定 idea_id/idea_version/ExperimentSpec/src 哈希（复用 prepareSpecRecording/executeSpecRun/attachSpecResult 共享生命周期，幂等重跑）、七类失败分类（code→engineering、dep/env/timeout→environment、data→data、resource→resource、invalid-result→metric；运行期分类永不产生 hypothesis/effect）、analyzeIdea 判定阶梯（invalid-run/rejected/inconclusive/supported；崩溃≠假设失败、缺对照不称优、单种子/单尺度/机制消融缺失均 inconclusive；分析读取 baseline(repro+覆盖 spec)/主实验/消融/多种子多尺度覆盖/资源/日志、镜像历史保留全部失败结果）、idea ablate/analyze CLI、analysis-v<N>.json 不可覆盖版本历史 | a938f1b | 门禁 57 files/426 vitest+9 python 全绿（15 条 analysis 测试：分类不变量、矩阵推导、六档判定、CLI 消融矩阵+幂等+绑定、跨版本分析历史保留、失败结果保留）| LLM Result Analyst 增强（语义归因）属凭据解锁；EVALUATION 语料 gold set 待 Phase 6 | 下一模块：Handoff 复现包
2026-11-11 | Phase 5 Handoff 复现包：evaluateComparisonGate 抽共享（comparison gate 命令与 handoff 同一评估）、computeHandoffLevel 分级门禁（supported+种子≥2+双尺度+comparison gate→HANDOFF_READY；否则 PROMISING 带 blockers；rejected/invalid-run→EXPLORATORY 拒绝打包）、buildIdeaHandoff 九件套（full-data-config.yaml/full-split-manifest.json/environment.lock.txt(pip freeze 有界+回退)/commands.txt 用户自跑声明/resources.json 实时容量建议/provenance.json 含 codeHash·specHash·protocol·输入哈希·comparison 溯源/known-risks.md 保留失败与不确定性/reproducibility.md 含阶梯与边界/handoff.json 门禁记录）、检查过期与分析过期自动重算 | 75ab63f | 门禁 58 files/432 vitest+9 python 全绿（6 条 handoff 测试：等级阶梯单测三档、九件套完整+yaml 可解析+provenance 绑定、无 check 拒绝、rejected 拒绝打包防洗结果）| HANDOFF_READY e2e 需真实基线+多种子+双尺度（单测覆盖 READY 档）；交付确认 Decision/Event 随 guided 策略落地 | 下一模块：guided/autonomous/review-only 自动化策略
2026-11-11 | Phase 5 guided/autonomous/review-only 自动化策略：config policy.autonomy_mode（默认 guided、init 模板、枚举校验）、workflow/autonomy 策略矩阵（protected 四类+finalize-handoff：guided 需 --confirm、autonomous 放行但必记 Decision/Event、review-only 拒绝 write-code/start-experiment/finalize-handoff；assertAutonomy 抛 USER_INPUT_REQUIRED）、recordDecision 绑定最新 run 的 Decision 事件（guided=user/confirmed、autonomous=system/auto）、主指标协议守卫 assertMetricsMatchProtocol（协议指标缺失即拒，杜绝静默改主指标）、接线：comparison set-status excluded(required) 与 idea branch 需 --confirm 并记事件（reason 校验先于策略）、idea experiment/run-ready/ablate/revise/scaffold/checkpoint 与 baseline repair/reproduce 的 review-only 拒绝、handoff READY 交付需 --confirm、autonomous 实验记 start-experiment 决策 | 84739fd | 门禁 59 files/444 vitest+9 python 全绿（12 条 autonomy 测试：模式矩阵、指标守卫、配置默认+枚举、guided 排除双确认+事件、autonomous 审计 auto、review-only 拒写可读、branch 确认无副作用）| 数据用途变更入口本就不存在（manifest 只读绑定）；协议重锁流程沿用 confirm protocol 既有 Decision | Phase 5 checkbox 全部完成（LLM 类 Agent 角色为凭据解锁项）；已知增强项：OOM/温度实时监控、运行时资源反馈与通知
2026-11-11 | Phase 6 真实材料端到端验证（确定性+恢复后的凭据）：论文只读比对 引用文献↔papers 68/68 sha256 全一致（零新增零丢失，原目录零改动）；gitignore 实测 .env/papers/knowledge/ideas/comparisons 全忽略、外部数据集在仓库外、git ls-files 跟踪真实论文/数据=0；数据 manifest 复验 20 客户端 x=[N,1,28,28]f32 y=int64 标签分布+TV0.7348+rootHash、零拷贝切片6个（train/test×smoke/quick/standard）+knowledge/slices-e2e.json 导出+idea 输入绑定（双文件哈希，verify OK）；FTS/BM25 检索冒烟80页命中、embedding 本地缓存可用但未依赖；DEEPSEEK_API_KEY 曾为空→用户补填→dsh-keyed 真实模型测试通过；协议 proto-a7a9cc2d0e64-v1（早前真实模型生成+researcher 锁定+泄漏门禁）沿用未再锁；comparison baseline-majority（本地 git 导入 user 源、受控 npz allow_pickle）repair→smoke-tested，真实指标 smoke 1.0%/quick 4.0% 入注册表（repro-baseline-majority v2 + -quick v1）gate 1/1 PASS；idea client-balanced-prior（卡片锚定语料 p.1 label-skew+mcmahan17a+manifest TV）真实数据 check 全过→smoke/quick 实验（协议主指标名+百分比，v3 quick=4.0%）→消融2条→分析 verdict=rejected/effect-insufficient（Δ0、机制 supports=false、双尺度一致证伪）→handoff 正确拒绝打包；过程中修复3个真 bug（quick 未传 --scale、跨尺度比较污染分析、主指标守卫误伤辅助指标→收窄为首个主指标）| 1118775 | 门禁 59 files/444 vitest+9 python 全绿 + dsh-keyed 真实模型测试通过 | HANDOFF_READY 未达标（idea 被证伪，符合预期流程）；LLM IdeaCard 生成角色未建（无既有任务面，按"不扩展无关抽象"跳过）；人工 gold set 未建 | 下一模块：被证伪 idea 的修订迭代或 gold set 建立
2026-11-11 | Phase 6/9 gold set 合成回归样例（按用户限定：仅可提交合成/脱敏 fixture）：tests/fixtures/fl-goldset 六件套（synthetic PaperCard 含页/引文定位 claims、联邦 dataset-manifest 3客户端 shape/labelCounts 求和一致+TV+rootHash、protocol proposal 低置信项触发 confirmations、comparison gate 三态 fixture、rejected/revisable 双 idea 卡）+ tests/goldset.test.ts 六组断言（契约校验、manifest 统计一致性、确认项暴露、gate pass/skip/block、rejected→EXPLORATORY 拒打包、revisable 合法修订路径）| bbd19f1 | 门禁 60 files/450 vitest+9 python 全绿 | 未含真实语料人工标注集（需用户标注私有论文，按指示不提交真实材料）；LLM 生成样例仍需凭据任务面 | 下一模块：rejected idea 真实修订闭环
2026-11-11 | Phase 6/9 rejected→revise 真实闭环 + 分析方法学加固：tests/idea-revision-loop（gold set 卡片驱动：rejected 拒打包→NEEDS_REVISION→工程 revise v2→仅重跑 idea 节点（spec v2、消融绑 idea-v:2）→analysis-v1/mirror-v1/baseline spec 全保留→仍 rejected 仍拒打包；科学 branch 新 ideaId+parentIdeaId+scientific-branch 版本记录、父分析不删）；真实 client-balanced-prior v2 迭代（median-frequency 估计器：smoke 53% vs 基线1% Δ+52、quick 持平4%、v2 消融 supports=true）；暴露并修复3个分析漏洞：跨尺度配对（bestDelta 只计同尺度）、mixed-scale 降级（任一覆盖尺度无增益→inconclusive）、消融仅认当前 idea-v（防旧代码证据）、收集器补 repro-<id>-<scale> 后缀基线；真实终判 inconclusive（mixed-scale）→ handoff PROMISING 10文件（非 READY）| 067c4f9 | 门禁 61 files/454 vitest+9 python 全绿（17 analysis+2 revision-loop+其余相关套件）| 混合尺度与消融陈旧两个 reason 早退时只报首个（可后续并列累计）；HANDOFF_READY checkbox 保持未勾 | 下一模块：长周期 soak test + 磁盘阈值

2026-11-11 | Phase 9 长周期验证（加速时钟）+ 磁盘阈值：computeAdmission 磁盘地板（默认5GiB，低于阈值全量排队新实验并记 constraint，LONG_RUNNING 磁盘策略）、tests/soak.test 五项（磁盘阈值准入单测、OOM 分类必须 resource 非 hypothesis、加速时钟时间线：FakeWorker 完成1任务→决策事件→崩溃租约→ManualClock 过期重启恢复→reclaimed 队列化→决策事件存活→QUOTA block/continue→worker 收尾，断言首任务 attempt=1 不重做、无 leased/stale、run COMPLETED、事件 seq 1..N 无洞无重、recovery+decision 双在日志、纯虚拟时间租约窗过期）| 7d5e63a | 门禁 62 files/459 vitest+9 python 全绿 | 发布前真实一周硬件 soak 与备份失败/长期预算告警未做（checkbox 保持未勾）；GPU OOM 为分类级验证（真实 OOM 注入需 GPU 环境） | 下一模块：架构依赖方向检查（Phase 9 分层硬化）
2026-11-11 | Phase 9 架构依赖方向检查：tests/architecture.test 六条静态守卫（node:sqlite 仅限 workflow/sqlite 适配器、@deepseek-ai SDK 仅限 src/dsh/**（dsh-plugins 豁免）、domain 六模块零 commander/dsh-sdk/commands/sqlite 依赖、commands+cli 不直连 sqlite/dsh-sdk、REPL 无 workflow/db·runtime 直连且经 cli/runner 转发（ADR-006）、状态机 types 无 CLI 依赖）+ 最小重构：comparison smoke 内联 spawn 抽换为共享 runRepairCommand/writeRepairLog（与 baseline repair 同路径，消除子进程重复实现）| ea0c79e | 门禁 63 files/465 vitest+9 python 全绿 | composition root 仍集中在 commands/shared.ts（过渡态，完整 DI 组装留后续硬化）；ExperimentRunner 仅执行锁定 spec 的类型级约束由 ExperimentSpec 参数类型体现，未加运行时水印 | 下一模块：plan dry-run（P0 产品验收）
2026-11-11 | Phase 9 plan dry-run：ideaseek plan [--question|--run|--json]（零副作用聚合：input-manifest 论文/字节统计+已索引数、comparison 注册表+gate 预览、idea workspace/就绪数/上限、切片按尺度、模型 route+凭据存在性（不打印值）、实时 host 探测、带 basis 标注的估算（token 启发式=estimate、max_model_cost/max_gpu_hours=预算天花板非预测、协议 resourceEstimate 原文引用）、guided 审批节点四件套、阻塞清单（config/gate/协议未锁）、--run 附现有 run 剩余任务；startedNothing 断言）| 42faf37 | 门禁 64 files/468 vitest+9 python 全绿（3 条 plan 测试：dry-run 全字段+run 未创建、--run 进度不产生第二 run、非项目拒绝）| 成本预测仅预算天花板（无 provider 价目表）；论文 token 为启发式标注 | 下一模块：explain task/decision/artifact（P0）
2026-11-11 | Phase 9 explain task/decision/artifact（PRODUCT_REQUIREMENTS P0）：ideaseek explain 三态溯源（task=run 上下文/attempt/幂等键/脱敏错误/产物/关联事件/产出规则、decision=事件 seq→RunEvent+run 绑定+不可改写规则、artifact=hash/大小/提交任务/run+完整性校验 verifyFileHash→verified|mismatch|missing 退出码0/1）、WorkflowDb.getArtifact 单条访问器（迁移无改动，纯查询）、全部只读重建不重跑任何东西 | 41259c7 | 门禁 65 files/471 vitest+9 python 全绿（3 条 explain 测试：task 全字段+幽灵拒绝、decision seq 绑定+坏输入、artifact verified→篡改→mismatch 退出1+幽灵/用法）| decision 仅扫最新 run（更早 run 的决策需 --run 范围扩展，后续增强）；explains 不含模型 prompt（按安全边界） | 下一模块：/models 模型路由状态（P0）

2026-11-11 | Phase 9 /models 模型路由状态（Journey B + MODEL_ROUTING.md）：src/models/routing 四层 tier（fast/balanced/deep/deterministic→MODEL_ROUTING 角色表14角色、deterministic 零模型、默认绑定=DSH 适配器 provider/model（deepseek-official/deepseek-v4-flash）、IDEASEEK_MODEL_<TIER> 环境覆盖、credentialStatus 仅存在性）、ideaseek models list（project route+DSH pin+凭据 presence+逐 tier provider/model/roles/能力标注+规则文案，JSON 前置 sk- 形状拒绝带）、models use <route>（guided 需 --confirm、写 research.yaml model_route、必记 change-model-route Decision、运行中任务保快照）、REPL /models 转发、autonomy ProtectedAction 增补 change-model-route | e09e2db | 门禁 66 files/477 vitest+9 python 全绿（6 条 models 测试：tier/角色/覆盖/凭据形状、CLI 脱敏、use 确认+决策事件+坏路由、REPL 转发）| 连接测试/额度限速/成本累计未接入（需 provider 侧遥测）；provider 隐藏输入配置流（Journey B 后半）未做 | 下一模块：cleanup/archive/export（P0 生命周期）
2026-11-11 | Phase 9 cleanup/archive/export（PRODUCT_GAPS #6 结果生命周期）：cleanup [--cache]（仅枚举 .research/artifacts/tmp + 陈旧 daemon.json；beginCommit 未 finalize 的 staged temp 经 listStagedTempPaths 保护、dry-run 默认、papers/ideas/knowledge 结构上不可达）、archive --run（reports/archive-<id> 四件套 events/tasks/artifacts/archive.json + decision 事件、run 保持完全可读）、export --run --to（artifacts 逐文件 sha256 进 export-manifest、events/tasks/run 全量脱敏、绝不拷贝 .env、sk- 形状值拒绝出仓（带词边界防 task- 误杀，redactSecrets 同步修边界））、WorkflowDb.listArtifactsByRun+listStagedTempPaths | 464ef14 | 门禁 67 files/480 vitest+9 python 全绿（3 条 maintenance 测试：dry-run→staged 保护→cache 删除孤儿不碰原件、archive 可读+决策审计、export 哈希清单+无 .env+事件 token 脱敏）| 嵌入式 embedding 缓存（用户级 ~/.cache）未纳入清理（跨项目共享，留 --user-cache 后续） | 下一模块：多项目注册与项目锁（P0）
2026-11-11 | Phase 9 多项目注册与项目锁（PRODUCT_GAPS #5）：runtime/registry 用户级 projects.json（init 幂等登记 fresh/already 双路径、IDEASEEK_REGISTRY_PATH 覆盖使测试永不碰真实 ~/.ideaseek、global-setup 统一重定向）、runtime/project-lock 咨询锁（live 外部 pid→RUN_BLOCKED 快速失败、死 pid 自动接管并记 note、同 pid 可重入、release 只删自己的锁；worker 走 DB 租约不占此锁）、run 命令全程持锁 finally 释放、ideaseek projects [--json] 只读探测各注册项目（exists/lastRun/lock+alive/daemon，recover:false 防写）| 9c6753f | 门禁 68 files/484 vitest+9 python 全绿（4 条 projects 测试：注册幂等+隔离路径、锁三态（live 拒/死接管/幂等释放）、projects CLI 登记与状态、run 并发冲突→锁释放后恢复；全量套件无竞态回归）| detach daemon 不持此锁（由 daemon.json+任务租约协调，文档化）；跨机注册同步未做 | 下一模块：自然语言 REPL 查询与高影响确认（P0 收尾）
2026-11-11 | Phase 9 自然语言 REPL 查询与高影响审批（Journey E + GAPS #1）：src/cli/nl 确定性意图矩阵（查询类：status/next/为什么/各域列表/模型路由→转发现有 CLI use-case；高影响类：优先级/预算/comparison 排除/假设变更/暂停 idea→pending-approval Decision 绝不执行；未知→引导语）、ideaseek decision propose <text...>（pending-approval RunEvent，明示 nothing was changed，审阅后用等价命令 --confirm 应用）、recordDecision 增加 status（confirmed/auto/pending-approval）、REPL 非斜杠输入走 interpretInput（query→relay、pending→decision propose、unknown→hint），/help 补自然语言说明；REPL 仍零 workflow/db 直依赖（经 CLI 转发，架构守卫保持绿）| 3d891d6 | 门禁 68 files/487 vitest+9 python 全绿（interactive 19 条含3条 NL：状态查询应答、高影响请求落 pending 且 ideas 零副作用、未知引导）| 语义理解为词法规则非模型（模型解释需 DSH 任务面，凭据解锁后可增强）；意图白名单外的表述归入 unknown 不猜测 | Phase 9 P0 清单完成项：plan/explain/models/门禁/NL/项目锁/清理导出；余：用户级配置分层（provider 隐藏输入）、ExperimentRunner 训练内 checkpoint
2026-11-11 | Phase 7 用户级/项目级配置分层（GAPS #3 + CONFIG_SPEC）：src/config/user-config（~/.ideaseek/config.yaml 或 IDEASEEK_USER_CONFIG 覆盖：models.provider/defaultRoute/credentialRef、embeddings.cacheDir、notifications；严格校验——未知字段报错、credentialRef 只接受 env:NAME|dsh:id 引用、任何 sk-/token 形状值硬拒绝、webhook 禁嵌 token；缺文件→零错误默认、坏 YAML→返回错误不抛）、resolveCredentialPresence（引用→configured/missing/store/not-configured，结构永不含值）、config explain 增补 user 段（逐字段 [user-default|user-file] 来源+边界声明：项目 research.yaml 永不读写用户 secret）、models list/userConfig 段（provider+credentialRef+presence）、doctor user-config 检查（错误→error、引用缺失→warn）| 9681f4b | 门禁 69 files/496 vitest+9 python 全绿（9 条 user-config 测试：默认/合法文件/secret 拒绝/未知键、加载缺文件与坏 YAML、presence 解析零泄漏、explain 双层+项目文件零改动、secret 配置 explain 退出2且不回显、models/doctor 接线）| provider 隐藏输入配置向导（Journey B 后半）与通知 webhook 实发未做；用户配置无 setter 命令（手编文件+doctor 校验） | 下一模块：ExperimentRunner 训练内 checkpoint 能力（LONG_RUNNING）
2026-11-11 | Phase 7 勾选对齐（并行会话重构清单后按当前 checkbox 重核）：自然语言 REPL 与高影响确认（3d891d6）、模型路由 fast/balanced/deep/deterministic（e09e2db：四层注册表+14角色+use 切换+审计；实际按 tier 选型仍走 DSH provider 默认绑定）、用户级/项目级配置+多项目注册+项目锁（9681f4b + 9c6753f）均已有实现+测试+commit；未勾项保持诚实：权限审批（工具级）、通知/反馈入口、发布前真实 soak、备份失败/预算告警、ExperimentRunner 训练内 checkpoint、ResearchRun 编排硬化、Journey A–H 正式验收、IdeationRound
2026-11-11 | Phase 7 实验级 checkpoint/resume（LONG_RUNNING §实验级 checkpoint）：src/experiment/checkpoint 契约（CheckpointPolicy steps/seconds/epoch/none 解析、computeSpecConfigHash 排除墙钟只哈希 command/metrics/seeds/数据/协议/尺度、validateCheckpointCompatibility 四路漂移即拒：code/protocol/data/config、progress/checkpoint_saved 行解析、buildCheckpointManifest 绑定 spec 身份、recovery 二分：保存过 checkpoint=checkpoint 否则 task-level 明示只重跑本实验）、executeSpecRun 集成（policy 转发 --checkpoint-every、心跳/清单落 experiments/progress-<specId>.json、失败时基于当前输入预检 resumeHint、timeout→interrupt force-kill）、idea experiment --resume（task-level 拒绝并指明 WITHOUT --resume、不兼容列出 mismatch、兼容则追加 --resume-from 执行）、配置 checkpoint 项接入 config/train.json | a099b81 | 门禁 70 files/504 vitest+9 python 全绿（8 条 checkpoint 测试：策略解析/配置哈希稳定与敏感、兼容矩阵全漂移、进度与清单解析、CLI 全链（check→崩溃留 ckpt→--resume 成功且 argv 含 --checkpoint-every/--resume-from）、task-level 拒绝 resume+force-kill）| 真实训练器按输出协议（{"progress"}/{"checkpoint_saved"}）接入即获 resume；scaffold 条目已演示、第三方代码不支持时自动 task-level | 下一模块：IdeationRound 多轮 idea 或 Journey 正式验收
2026-11-11 | Phase 7 IdeationRound 多轮 idea/去重/反馈回流（docs/IDEATION_ROUNDS.md）：src/idea/rounds 不可变轮次对象（冻结 inputManifest/paperCards/researchMap/protocolId+hash/comparisonSet/datasetRootHashes 快照、继承上一轮 idea refs+指纹+反馈标签、noveltyConstraints（角色:组件+hypothesis 声明）、knownFingerprints 去重基线、stopReason no-new-information）、createRound 变化检测（输入/研究地图/卡片数/协议/比较集/反馈任一变化否则诚实报"没有足够新信息"不凑数，首轮也继承既有 idea）、ideate --round new|--round rN --continue（continue 只读不改轮次）、rounds list/show 只读、feedback append-only（labels: useful/invalid/prior-work/experiment-invalid/protocol-error/data-error/baseline-unfair + feedback RunEvent 绑定 run、无 run 仅文件记录）、ideaFingerprint 键序稳定对假设/机制/近邻敏感 | 6d67aa5 | 门禁 71 files/510 vitest+9 python 全绿（6 条：指纹稳定性、r1 快照、r2 无新信息门+中文诚实提示、反馈检出新信息+append-only+继承、feedback 事件+标签/幽灵校验、show 快照+continue 只读）| 候选生成本身是 Idea Generator（凭据面）；语义近邻去重为指纹级（embedding 近邻属后续增强） | 下一模块：Journey A–H 正式验收或 ResearchRun 编排硬化
2026-11-11 | Phase 1.5 CLI 交互续接（slash 菜单+自然语言 ask+Research/Agent 模式+项目切换）：slash-menu 输入 / 立即开菜单（↑/↓ 选择、Enter 执行、Esc 关闭、Tab/唯一前缀补全、宽度截断与 usage 提示、纯模块+REPL 管 readline）、tokenizeArgs 引号感知分词（/ideate --question "ux test" 完整落参、ask 转发共用）、ideaseek ask（确定性查询→同一批 CLI use-case、高影响→pending-approval Decision 绝不执行、其余→DSH supervisor 分类，测试强制 fake harness）、.research/session.json 会话模式（temp+rename）、ideaseek mode [research|agent] 显示 mode/project/autonomy/strategy+权限摘要并记 Decision/Event（显式切换免 --confirm、不启第二个 run）、research strategy 移至 mode --strategy（guided --confirm）、interactive --mode、/open 两步项目切换（path/注册表名解析→preview 摘要→--confirm chdir+事件流重启+header 重印、歧义/缺失目录硬错误、非项目回退文档浏览）、全局 --project <path>（argv 任意位置提取+chdir）、runner 启动锁定入口绝对路径（chdir 后 relay 不丢脚本）| 52c415d + e33d928（基础切片随 c0cca8d 入库）| 门禁全绿：542 vitest + 9 python（session-mode 4、open-project 6、repl-ux 22、interactive 19；format:check/lint/typecheck）| Agent 模式仅落地模式与权限面，DSH Agent/Session 工具执行按 MODES.md 后置；孤立 ESC 在 Node ~500ms escapeCodeTimeout 内会与后续按键合并（测试等待规避） | 下一模块：protocol/experiment/权限审批交互
2026-11-11 | Phase 1.5 protocol/experiment/权限审批交互：src/approval/pending 只读扫描（未锁定 protocol-proposal→confirm protocol、pending-approval Decision→仅审阅绝不执行、repair confirmation-required→comparison set-status 接受代码修订，每项都指向既有命令零逻辑复制）、ideaseek pending [--json]（无待办 exit 0 / 有待办 exit 2 可脚本化）、REPL 确认块（启动时与 /pending 触发，TERMINAL_UX 方框+窄终端截断）、/approve [n] 转发既有命令、块内裸数字直接选择、多项时要求显式 /approve <n>、决策项 review-only 明示、/approve 无待办时平实告知；退出竞态防护（println 不在已关闭的 readline 上重新 prompt + attach spawn error 兜底，修复并行负载下偶发 exit 1）| 03644d3 | 门禁全绿：75 files/550 vitest + 9 python（pending-approval 7、interactive 19、repl-ux 23；format:check/lint/typecheck）| 工具级 DSH 权限提示（运行中工具调用审批）未启用——Phase 1 提取不调用需审批工具，留待 Agent 工具面；Decision 的落地仍需用户以等价命令 --confirm 执行（REPL 不代跑任意命令）| Phase 1.5 checkbox 全部完成
2026-11-11 | Phase 4.5 起步：ARIS 能力审计（docs/ARIS_AUDIT.md：6 项能力两侧契约对比、迁移/保留结论、conformance 必测路径）+ vendored skill 地基（aris-skills/：11 个 P0 SKILL.md + 17 个 shared-references + MIT LICENSE/NOTICE 记录上游 commit 8f49392）、src/aris manifest（28 文件 SHA-256）+ skill 加载器（完整性拒绝篡改、frontmatter 解析、$ARGUMENTS/{{var}} 渲染、shared-reference 解析、IDEASEEK_ARIS_SKILLS 覆盖活仓库）、ideaseek aris [--json]（来源/许可证/清单/完整性，失配 exit 2）| 5f6fdb0 | 门禁：format/lint/typecheck 绿 + vitest tests/aris-skill.test.ts 9 条 + 全量 76 files/559 vitest+9 python | skills 为纯 Markdown prompt（无第二套 agent loop）；执行 backend 迁移随各能力 checkbox 落地 | 下一模块：idea-discovery/idea-creator 接入 IdeaCard/IdeationRound
2026-11-11 | Phase 4.5 capability 1 idea-discovery/idea-creator → IdeaCard/IdeationRound：src/idea/generate（round 上下文组装 + idea-candidates-v1 输出契约紧贴 vendored ARIS idea-creator skill 体——薄 adapter：方法论来自 ARIS、schema/门槛来自 IdeaSeek；validateIdeaCard 逐卡校验 + knownFingerprints 指纹去重 + 诚实空结果带 reason + candidates.json 与逐卡文件原子写 + inputHash（skill sha + round 快照）幂等复用）、ideaseek idea generate --round rN [--harness] [--force] [--json]（SKILL_TAMPERED 在任何模型调用前拒绝、HarnessBlockError→exit 2 零写入、有 run 时记 idea_candidates 事件、复用不重复记账）、ideate 交接改为真实命令、HarnessProfile 增 idea-generator、fake harness 确定性合法卡片与 IDEASEEK_FAKE_IDEA_OUTPUT/BLOCK 测试钩子、ArisSkillError 并入 IdeaseekError 错误分类（error: [SKILL_TAMPERED]，exit 2）| 27d8fb9 | 门禁全绿：77 files/567 vitest + 9 python（idea-generate 8 条：成功→validate→create 链、幂等复用不重复事件、诚实空结果、坏输出零写入、round 缺失、技能篡改拒绝、额度阻塞后恢复、假设语句贯通）| idea-discovery 的多阶段编排（research-lit→creator→novelty→review→refine 与 evidence gate 脚本）未整链接入——其 novelty/review 阶段分属后续能力 checkbox；dsh 真实模型调用待凭据 | 下一模块：experiment-plan/experiment-bridge 接入 ExperimentSpec/RunResult
2026-11-11 | Phase 4.5 capability 2 experiment-plan/experiment-bridge → ExperimentSpec/RunResult：src/idea/plan（experiment-plan-v1 契约——claimMap/blocks/runOrder/computeBudget/risks/checklist，紧跟 vendored ARIS experiment-plan skill 渲染；结构校验绑定 ideaId+cardVersion；ideas/<id>/experiments/plan.json 原子写；inputHash 幂等复用）、ideaseek idea plan <ideaId> [--harness] [--force] [--json]（技能完整性先于任何模型调用、HarnessBlockError→exit 2 零写入、idea_plan RunEvent、诚实复用）、bridge 联动：buildIdeaSpec 对当前 plan 在 environment.notes 追加 plan:<hash>（RunResult 可溯源）、runIdeaExperiment 在真正执行前拒绝 primaryMetric 不在 spec metrics 中的计划（USER_INPUT_REQUIRED 零算力浪费；stale plan 只从 notes 摘除不阻塞；已记账结果仍幂等上报）、fake harness 由卡片上下文确定性出计划 + IDEASEEK_FAKE_PLAN_OUTPUT 钩子| b131521 | 门禁全绿：78 files/574 vitest + 9 python（idea-plan 7 条：plan→experiment→notes 含 plan: 哈希、指标漂移拒绝 exit2、幂等复用不重复事件、stale plan 不阻塞不入 notes、坏输出零写入、未知 idea、额度阻塞恢复）| 可执行 spec/队列/checkpoint/失败分类仍归 IdeaSeek（ADR-009）；plan 为可选增强（无 plan 的既有实验流不受影响）；dsh 真实调用待凭据 | 下一模块：ablation-planner 接入机制链和消融矩阵
2026-11-11 | Phase 4.5 capability 3 ablation-planner → 机制链+消融矩阵：src/idea/ablation-plan（ablation-plan-v1 契约：entries[kind/target/whatItTests/expectedOutcome/priority1-5]+coverage/unnecessary/suggestedOrder/估算，紧贴 vendored ARIS ablation-planner；target 对卡片校验——component∈componentNecessity、card-ablation∈minimalExperiment.ablations、hyperparameter/design 必须 null→deferred 只报告不丢弃；ablation-plan.json 原子写+inputHash 复用）、ideaseek idea ablation-plan <ideaId> [--harness] [--force] [--json]（技能完整性先于模型调用、额度阻塞 exit2 零写入、ablation_plan RunEvent、诚实复用）、runAblations 联动：当前 plan 按 priority 重排派生队列（测试证明与派生顺序相反）、每个 spec notes 追加 ablation-plan:<hash> 与 expect:<预测结果>、结果带 coverage/deferred/unmatched 供 CLI 汇总；stale plan 顺序与 notes 原样不动、fake harness 由卡片出条目 + IDEASEEK_FAKE_ABLATION_PLAN_OUTPUT 钩子| 0dba8ce | 门禁全绿：79 files/580 vitest + 9 python（ablation-plan 6 条：生成→重排→notes 注解、stale 中性、幂等复用不重复事件、非法 target 拒绝、坏输出零写入、额度阻塞恢复）| 推导/绑定/执行仍归 IdeaSeek（ADR-009）；hyperparameter/design 类条目需自定义代码，deferred 明示；dsh 真实调用待凭据 | 下一模块：novelty-check/prior-art-search 接入 PaperCard 和 evidence
