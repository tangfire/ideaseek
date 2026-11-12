# IdeaSeek 依赖与成熟组件策略

本文档把“能复用就不重写”落实为开发门禁。IdeaSeek 是科研工作流产品，不应重新实现 Agent Runtime、通用终端渲染、通用进程管理、通用 schema 校验或通用 GitHub API。

## 评估顺序

新增模块前按以下顺序检查：

1. DSH 是否已经提供 Agent、Session、Tool、Subagent、provider、上下文和权限能力。
2. ARIS 是否已经提供对应的科研 skill、workflow、reviewer、审计或报告能力。
3. 现有仓库依赖是否已经覆盖需求。
4. 是否存在许可证清晰、版本稳定、跨 Windows/Linux 可验证的成熟开源包。
5. 能否通过配置、插件或薄 adapter 接入。
6. 只有外部组件无法满足 IdeaSeek 的状态、权限、资源、checkpoint、恢复或结构化结果契约时，才新增自有实现。

## 当前组件边界

| 能力 | 首选复用来源 | IdeaSeek 自己保留的部分 |
|---|---|---|
| Agent Runtime | DSH | HarnessAdapter、角色权限和科研任务映射 |
| 科研 workflow | ARIS | IdeaCard、ExperimentSpec、RunResult、Artifact、Decision、RunEvent 和 checkpoint |
| TUI | Ink 或同等级成熟 TUI 框架 | UI 与 use-case 的 adapter；plain/json 仍走行式输出 |
| CLI 参数 | Commander | 命令到 application use-case 的映射 |
| 契约校验 | JSON Schema (draft-07) + **ajv 8.20.0**（MIT，锁版本） | schema 版本、迁移、跨 TS/Python 的单一权威契约 |
| 子进程 | **tree-kill 1.2.2**（MIT，进程树回收）+ 本仓 `src/core/proc.ts` 薄 adapter | 租约、超时、取消、失败分类和恢复语义 |
| GitHub | Git CLI + 可选 API adapter | 来源、commit、license、权限和审计记录 |
| PDF/科学解析 | Python 生态成熟库 | 解析器版本、证据定位、哈希绑定和失败回退 |
| 检索 | FTS/BM25 + 本地 embedding | 混合排序、缓存指纹和证据免责输出 |
| 容器/GPU | Docker/Podman、系统探针 | 资源准入、排队、实验公平性和运行快照 |

## 新依赖门禁

每个新依赖必须记录：用途、版本、许可证、来源、维护状态、Windows/Linux 验证、替代方案、adapter 边界和测试方式。依赖不能：

- 创建第二套 Agent Loop、Session、任务数据库或实验队列；
- 绕过 IdeaSeek 的权限、预算、comparison gate、checkpoint 或事件审计；
- 把用户原始数据、凭据或完整日志上传到未授权的外部服务；
- 让 interactive、plain、JSON 三种输出路径出现不同的业务语义。

迁移通过 conformance/regression tests 后，应删除旧的重复默认实现；不要长期维护两套默认 workflow 或两套默认 TUI。

## 已引入依赖记录

### tree-kill 1.2.2（进程树回收）

- **用途**：`killTree(pid)` 杀掉整棵进程树——Windows 走 `taskkill /T /F`，POSIX 走递归 ppid 遍历。没有它，`child.kill('SIGKILL')` 在 Windows 只杀直接子进程，node relay 背后的 python worker、cmd 包装的 pip 都会变孤儿。
- **版本/许可证**：1.2.2（锁版本），MIT；自带 `index.d.ts` 类型。
- **来源/维护**：npm `node-tree-kill`，多年事实标准、代码量极小、无传递依赖；功能稳定无需跟进上游。
- **Windows/Linux 验证**：Windows 11 上 `tests/proc.test.ts` 7 条全绿（祖孙双进程树回收、超时、AbortSignal 取消、幂等、自身保护）；POSIX 分支由同一套测试在 Linux/WSL 执行（tree-kill 内部实现差异，adapter 语义不变）。
- **adapter 边界**：`src/core/proc.ts` 只暴露 `killTree`/`killTreeSafe`/`runProcess`（超时、取消、退出码、失败标志）；租约、失败分类、恢复语义仍归 IdeaSeek。原 10 处 `child.kill('SIGKILL')` 调用点已迁移到该 adapter。
- **替代方案**：execa（功能重叠更多、体积更大，当前只需要树杀+缓冲运行）、手写 taskkill/ps 分支（正是要避免的重复实现）。
- **测试方式**：`tests/proc.test.ts`；runner/extract/repair/pdf/embeddings/importer 全量回归。

### ajv 8.20.0（契约校验）

- **用途**：编译 `src/core/schema/schemas/*.json`（draft-07）做结构校验；`validateAgainstSchema`/`assertAgainstSchema` 是唯一入口。
- **版本/许可证**：8.20.0（锁版本，无 `^`），MIT；`pnpm release-check` 许可证 allowlist 覆盖。
- **来源/维护**：npm 官方包，JSON Schema 社事实上标准实现；此前已是 eslint 的传递依赖，本仓库改为直接声明。
- **Windows/Linux 验证**：Windows 11 全量 vitest 通过；纯 JS 无原生依赖，跨平台无差异。
- **adapter 边界**：ajv 只回答“结构是否符合契约”；语义规则（证据核验、哈希绑定、状态机）留在领域模块；错误统一映射为 `SchemaIssue{path,message}` 与 `INVALID_ARTIFACT`。
- **替代方案**：zod/typebox（自有 DSL，不产出可被 Python/ARIS 直接读取的 JSON Schema 文件，否决）、手写校验（已存在多套平行实现，正是要收敛的问题）。
- **测试方式**：`tests/schema.test.ts` —— 与 `validatePaperCard` 的 21 例决策一致性矩阵、错误路径、extract 持久化边界 fail-closed 与无误杀 e2e。

## 当前待办

- 以 Ink 完成 interactive TTY 应用壳，并删除旧的默认 readline/ANSI 重绘路径。（✅ 2026-11-12 完成：`src/cli/shell/app.tsx` 为唯一 TTY renderer，行式路径仅服务 plain/json/非 TTY）
- 评估 JSON Schema 校验器，统一 TypeScript、Python worker 和 ARIS 结构化契约。（校验器已定 ajv 并接入 papercard-v1 持久化边界；Python worker 读取同一 JSON schema 文件、ARIS 输出契约迁移待后续切片）
- 评估跨平台子进程 adapter，覆盖 Windows/Linux 的超时、取消和进程树回收。（✅ 2026-11-13 完成：tree-kill + `src/core/proc.ts`，10 处 kill 调用点迁移，`tests/proc.test.ts` 7 条；POSIX 分支由同一套件在 Linux/WSL 执行）
- 评估 GitHub API adapter，仅用于元数据、license、release 和限额，不替代 Git clone。
- 仅在需求出现时评估文件扫描、watch、结构化诊断日志和扩展归档解析库。

