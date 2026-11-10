# IdeaSeek 开发进度

这是后续开发 Agent 必须持续更新的进度文件。完成一个可验证模块后，把对应 `[ ]` 改为 `[x]`，填写 commit、测试和已知限制；未完成或只有空壳的模块保持 `[ ]`。不要为了看起来完整提前打勾。

## Phase 0：项目骨架与恢复

- [x] `ideaseek init` 幂等创建项目目录和模板
- [ ] `ideaseek start` 小白用户一键入口和规模自适应策略
- [ ] `ideaseek setup/doctor/config explain`
- [ ] 自动检测 Python/Node/容器/CUDA/GPU/磁盘
- [ ] `scan/intake/organize` 与 InputManifest
- [ ] `starter/standard/research` 运行策略和报告措辞
- [ ] 配置 schema、迁移和 ResolvedConfig 快照
- [x] Workflow DB 与 artifact store 接口
- [x] Task lease、heartbeat、重试、取消和幂等提交
- [x] RunEvent 持久化、`status/next`
- [ ] 后台 supervisor、`attach/watch/events`
- [x] `pause/resume/continue/cancel`
- [x] 故障注入和 checkpoint 恢复

## Phase 1：DSH 集成

- [ ] 固定 DSH commit/包版本和兼容性测试
- [ ] `HarnessAdapter`
- [ ] Cordis plugins/bundles/profile 加载
- [ ] 模型 provider、额度耗尽和凭据恢复
- [ ] Agent capability profiles
- [ ] Tool schemas、权限和审计事件
- [ ] 假 Paper Extractor 端到端任务

## Phase 2：论文与知识库

- [ ] PDF/LaTeX/OCR/表格/图表解析
- [ ] PaperCard schema 和证据定位
- [ ] 去重、全文/向量检索和增量处理
- [ ] Paper Extractor 并行 map 阶段
- [ ] Evidence Checker
- [ ] 主题综合、机制库和研究地图
- [ ] 论文 gold set 回归

## Phase 3：数据与实验协议

- [ ] Dataset Analyst 和 dataset card
- [ ] Protocol Synthesis Agent
- [ ] Leakage/Validity Checker
- [ ] ExperimentalProtocolProposal schema
- [ ] 用户确认和 protocol lock
- [ ] Scenario Planner 和实验组合 L0–L4
- [ ] DatasetSlice `smoke/quick/standard`、handoff manifest 和晋级规则
- [ ] 数据分布保持、客户端/域/主体边界和泄漏检查
- [ ] 首发领域验证（优先联邦学习模型异构）及人工 gold set

## Phase 4：Comparison

- [ ] comparison manifest 与 required 状态
- [ ] 用户仓库导入和 upstream/worktree 隔离
- [ ] 官方代码定位和许可证记录
- [ ] Baseline Repair Agent
- [ ] Baseline Reproduction Agent
- [ ] 统一 ExperimentSpec/RunResult
- [ ] 所有 required comparison 门槛

## Phase 5：Idea 与实验闭环

- [ ] Mechanism Analyst、Idea Generator、Research Discussant
- [ ] Novelty Challenger、Synthesis Lead
- [ ] IdeaCard 机制链和 `DRAFT_COMPOSITION` 门槛
- [ ] 独立 idea workspace 和代码版本
- [ ] Code Implementer、smoke test、静态检查
- [ ] GPU Capacity Planner 和多 idea 并行
- [ ] 主实验、消融、失败分类和结果分析
- [ ] Idea 版本迭代、否证和新 idea 分支
- [ ] 结果/报告/复现清单

## Phase 6：扩展与发布

- [ ] 多 GPU 与本地 vLLM
- [ ] 多模态早期预测适配器
- [ ] 短视频适配器
- [ ] 图像分割适配器
- [ ] 联邦学习模型异构适配器
- [ ] 联邦学习域泛化适配器
- [ ] Linux 发布包和 WSL2 验证
- [ ] 回归、依赖/许可证/secret 检查
- [ ] 备份恢复演练和发布清单

## 模块交付记录

每个完成模块追加一行：

```text
YYYY-MM-DD | 模块 | commit | 测试命令/结果 | 已知限制 | 下一依赖
```

```text
2026-11-10 | Phase 0 可恢复垂直切片（init/status/next/events、Workflow DB、lease/heartbeat/重试/取消/幂等两阶段提交、RunEvent 回放、Artifact Store hash+原子提交、pause/resume/continue/cancel、假 Worker、故障注入与重启恢复） | 07f3cae | pnpm format:check && pnpm lint && pnpm typecheck && pnpm test → 7 files / 50 tests passed（含 Worker 崩溃、重复提交、租约过期、输出写入中断、进程重启、quota 阻塞、CLI e2e 退出码） | Windows 下 SIGINT 无法投递给子进程，Ctrl-C 语义只做了进程内测试；后台 supervisor/attach/watch 未实现；scan/intake/organize、setup/doctor、start 未实现；配置无迁移器；DSH 未接入 | 下一模块：ideaseek setup/doctor/config explain + 自动环境检测（依赖本切片的 config 抽象）
```
