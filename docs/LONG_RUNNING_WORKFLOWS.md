# 长周期科研工作流与恢复保证

IdeaSeek 的 run 可能持续数小时或数天，并且包含多轮 idea 设计、代码实现、quick/standard 实验、结果分析和 idea 分支。它必须是持久化工作流，不依赖某个 CLI、Agent 会话或单个 supervisor 进程一直存活。

## 持久化层级

```text
Project
  └── ResearchRun（长周期目标和策略快照）
       ├── WorkflowNode（论文/协议/comparison/idea/实验分析）
       ├── IdeaBranch（idea_id + version + parent）
       ├── ExperimentRun（独立运行、代码/数据/环境快照）
       ├── TrainingCheckpoint（训练内部恢复点，若 runner 支持）
       └── RunEvent/Decision/Artifact（事件、人工决定和不可变产物）
```

ResearchRun 保持同一个 run_id 跨越多轮迭代；每一轮 idea 和实验有独立 node/run ID。Agent 会话只是可重建的执行上下文，不是长期状态的唯一存储。

## 恢复粒度与保证

| 中断点 | 恢复行为 | 保证边界 |
|---|---|---|
| 论文提取任务中断 | 重跑当前论文/小批次 | 已提交 PaperCard 不重算 |
| 模型请求额度耗尽 | `QUOTA_EXHAUSTED`，等待额度/凭据恢复 | 已完成节点保留；请求已发出但未提交时可能重复单次费用 |
| supervisor/CLI/SSH 退出 | 后台 worker 继续或 supervisor 重启接管 | 任务状态与事件从数据库恢复 |
| 容器/Worker 崩溃 | 租约过期后重试当前 task | 由幂等键和 artifact 原子提交防止双写 |
| GPU OOM/节点重启 | 从最近训练 checkpoint 续训；不支持时只重跑当前 ExperimentRun | 不重跑其他论文、comparison、idea 或已完成实验 |
| 代码修改 | 新 code hash、新 check 和实验版本 | 只失效依赖该代码的下游结果 |
| idea 科学假设变化 | 创建新 idea_id 和 parentIdeaId | 保留旧 idea、所有结果和失败记录 |
| 人工确认等待数天 | `USER_INPUT_REQUIRED` 持久等待 | 不占用 worker/GPU；确认后续跑 |
| 一周无人值守 | 心跳/配额/磁盘/任务租约持续监控 | 长时间验证必须通过 soak test，不能仅靠单元测试宣称支持 |

## 实验级 checkpoint

ExperimentRunner 应通过统一接口暴露：

- `checkpoint_policy`：按 epoch、step 或时间间隔；
- `save_checkpoint`：模型、优化器、scheduler、随机数状态、数据 sampler、epoch/step 和配置 hash；
- `resume_from`：校验代码、协议、数据、环境和 checkpoint 兼容性；
- `interrupt_policy`：安全暂停、抢占信号、超时和强制终止语义；
- `progress_heartbeat`：当前 epoch/step、资源和最新 checkpoint ID。

不支持安全续训的第三方代码仍可运行，但必须明确标记为 task-level recovery：崩溃时重跑当前单个实验，不承诺恢复该实验内部进度。

## 防止一周运行悄悄失活

- Supervisor/worker 有独立 heartbeat 和失联阈值；`status` 区分 running、waiting、stale、blocked 和 failed。
- GPU/CPU/内存/磁盘/API 预算按小时汇总；磁盘达到阈值时先暂停新任务，不能把 checkpoint 写满磁盘。
- 长期 run 设置最大墙钟时间、最大 idea 轮数、每轮最大重试和无信息增益停止条件。
- 每轮结果提交后，先持久化 Idea/Experiment/Decision/Event，再生成下一轮任务。
- 多周运行应定期备份 DB 和 artifact manifest；备份失败进入显式告警状态。
- 凭据轮换、DSH/provider 变更或主机环境变化时暂停受影响任务并要求兼容检查，不盲目用旧 checkpoint 续跑。

## 验收测试

除了故障注入，还需要 long-run soak test：模拟至少一周工作流的事件时间线或加速时钟运行，覆盖多轮 idea revise/branch、GPU checkpoint、quota pause/resume、supervisor 重启、输入新增、人工审批等待、数据库备份/恢复、磁盘阈值和事件回放。检查结果没有丢失/重复提交，状态没有永久 stale，预算没有被重试绕过。真实长时间硬件 soak 可在发布前执行，不要求每次 CI 跑一周。

## 当前状态说明

文档设计了长周期恢复语义，不代表所有实验 runner 都已经实现训练内部 checkpoint，也不代表已经通过一周真实 soak test。功能是否完成以 `PROGRESS.md` 和对应测试/commit 为准。
