# IdeaSeek 开发启动步骤

## 目标

IdeaSeek 是独立项目仓库，DSH 是锁定版本的上游 Agent Runtime。不要一开始把整个 DSH 仓库复制进 IdeaSeek，也不要直接修改 DSH 核心。IdeaSeek 在自己的仓库中实现科研插件、工作流 Supervisor、CLI、数据库/Artifact 层和 Python Worker，通过 `HarnessAdapter` 接入 DSH。

## 推荐目录

```text
workspace/
  deepseek-harness/       # DSH 上游 clone，只作 API/本地开发参考
  ideaseek/               # IdeaSeek 私有 GitHub 仓库
```

如果外部 DSH 包已经足够稳定，IdeaSeek 通过锁定版本的 npm/pnpm 依赖使用它；如果需要本地调试 DSH 包，使用明确的 workspace/link 或 submodule，并记录 DSH commit，不复制未修改的源码到业务目录。

## 仓库准备

1. 在 GitHub 创建私有仓库 `ideaseek`。
2. 本地 clone IdeaSeek 私有仓库。
3. 将本套文档放到仓库根目录，至少包括：`AGENTS.md`、`README.md`、`plan.md`、`ARCHITECTURE.md`、`WORKFLOW_SPEC.md`、`IMPLEMENTATION_ROADMAP.md`、`PROGRESS.md` 以及其余契约/规范文档。
4. 在仓库根目录建立 `.gitignore`，排除 `.env`、secret、论文、数据、模型权重、实验日志、`.research/` 和大产物。
5. 首次提交只包含文档、空的源码骨架、配置模板和测试骨架，不提交真实论文/数据/API key。

## DSH 上游准备

```bash
cd workspace
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout <固定的 DSH commit 或 tag>
pnpm install
pnpm run typecheck
```

实际 commit/tag 在开发开始时记录到 IdeaSeek 的 `DEVELOPMENT.md` 或 `runtime-lock.json`，不要使用浮动的 `main` 作为生产依赖。

## IdeaSeek 首次启动

```bash
cd workspace/ideaseek
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

第一阶段只实现：

```text
ideaseek init
→ 创建项目目录
→ 创建一个 task
→ 假 Worker 执行
→ 提交一个 artifact
→ status/next 显示状态
→ 进程重启
→ resume 继续
```

Phase 0 不实现真正论文阅读、真实 GitHub clone 或 GPU 训练。先证明状态、事件、权限和恢复语义，再接入 DSH Agent。

## 给开发 Agent 的第一条任务

把下面的文字作为开发 Agent 的首个任务消息：

```text
你正在开发 IdeaSeek。先阅读仓库根目录的 AGENTS.md、README.md、plan.md、ARCHITECTURE.md、WORKFLOW_SPEC.md、DEVELOPMENT.md、IMPLEMENTATION_ROADMAP.md 和 PROGRESS.md，再检查 DSH 上游仓库及其 AGENTS.md、架构文档和公开插件/Agent/SDK API。

当前只做 Phase 0 的最小垂直切片：
1. 建立 TypeScript 项目骨架和 CLI；
2. 实现 ideaseek init、status、next、pause、resume；
3. 建立 Workflow DB 抽象、Task 状态、lease/heartbeat 和 RunEvent；
4. 建立 Artifact Store 的临时写入、hash 校验和原子提交；
5. 用假 Worker 跑一个可恢复任务；
6. 注入 Worker 崩溃、重复提交、租约过期和进程重启测试；
7. 不接真实模型、GitHub、论文解析或 GPU；
8. 更新 PROGRESS.md，但只有测试和 commit 完成后才能打勾；
9. 使用小 commit，不直接修改 DSH 核心。

完成后汇报：改动文件、commit ID、测试命令/结果、恢复语义、已知限制和下一模块依赖。
```

## TypeScript 与 Python 分工

- **TypeScript/DSH**：Cordis plugins、Agent profiles、工具注册、Supervisor、CLI、事件、任务协议、权限和模型会话。
- **Python**：PDF/科学文献解析、数据分析、Dataset Analyst、机器学习 baseline、实验训练和指标计算。
- **交界**：JSON Schema 任务协议、数据库任务记录和 Artifact 引用；Python Worker 不创建第二套 Agent Loop。

## 后续接入顺序

```text
Phase 0：假 Worker + 恢复
Phase 1：HarnessAdapter + 一个假 Paper Agent
Phase 2：真实 PDF/PaperCard
Phase 3：Dataset/Protocol Synthesis
Phase 4：Comparison Repair/Reproduction
Phase 5：Idea/Code/Quick 实验闭环
Phase 6：首个方向验证、可选插件和多 GPU 扩展
```

每个阶段都必须更新 `PROGRESS.md`、写失败测试、提交小 commit，并在下一阶段开始前保持 `main` 可启动。
