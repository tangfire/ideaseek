# 论文材料与云端文件管理 — 需求分析

日期：2026-11-28　分支：`feat/web-console`（ce1504f）　状态：设计阶段，未实现

## 1. 问题定义

用户点击进入项目后，"论文分析"阶段要求提供论文，但界面没有回答三个问题：

1. **在哪提供？** 全站没有任何上传/粘贴入口。
2. **提供了什么？** 用户看不到当前已登记了哪些材料、被哪个任务消费。
3. **怎么管理？** 已提供的材料无法查看、替换或删除。

后果是演示与真实使用都会撞墙：PAPER_ANALYSIS 阻断后，界面提示"补充论文材料后继续运行"（`web/functions/views.ts:446`），但**不存在任何能补写材料的接口**，提示是一条死路。

同一供给侧还缺文件本体的管理：论文 PDF、数据集、报告在云端**没有任何存储与读写接口**（§2.4），"材料与成果"页只能陈列元数据指纹。本需求把"文本材料提供"与"云端文件管理"作为同一条供给侧链路一起设计。

## 2. 现状分析

### 2.1 供给链路（代码证据）

| 环节 | 现状 | 位置 |
| ---- | ---- | ---- |
| 运行创建 | 只带 `question`，不含任何论文 | `web/functions/commands.ts:675` |
| 分析任务入队 | PAPER_ANALYSIS 自动入队，payload 仅 `{paper_id, index}` | `web/functions/engine/step-driver.ts:327-336` |
| 输入校验 | `paperInput()` 只认 `payload.paper_text` / `payload.abstract`，缺失抛 `PaperInputRequiredError` | `web/functions/engine/task-executors.ts:62-75` |
| 阻断 | run 置 `block_reason=paper_input_required`，阶段置 blocked | `step-driver.ts:78-86` |
| 恢复 | **已存在**：queued 任务的 payload 补齐后，下一次 step 自动清阻断 | `step-driver.ts:90-94` |
| 补写材料的 API | **不存在**。写路由只有 `/projects`、`/commands/*`、`/app/step`、`/ingest` | `web/functions/routes.ts` |
| 唯一真实供稿路径 | 本地 CLI `ideaseek ingest` 扫描 `papers/` 目录 | `src/commands/ingest.ts:166` |

### 2.2 数据存储

- 正文/摘要**只存在于 `cloud_task.payload`**（`web/migrations/0006_task_payload_result.sql`），没有独立的材料表。
- `cloud_paper_card` 只存书目元数据（title/problem/method_summary），表注释明言"摘要与正文属于用户语料，不落这张表"（`web/migrations/0001_projection_core.sql:207`）。
- 平台侧 `QODER_STORAGE` 出现在 env 探针名单但从未被调用（`web/functions/routes.ts:80`）；`/storage` 是平台保留命名空间，可作为文件存储候选，可用性未验证。

### 2.3 前端展示

- "材料与成果"页只有只读清单，横幅自述"论文上传、数据集接入及代码包/报告下载尚未接通"（`web/console/src/resources.tsx:158`）。
- 缺口提示"尚缺论文正文或摘要"（`resources.tsx:80`）只有文字，无动作按钮。
- 阶段详情只罗列任务的输入/产出字段（`web/console/src/stage-details.tsx`），**没有"本阶段需要什么输入、已有什么、缺什么"的清单式表达**。
- 阻断卡片 `BlockReasonCard`（`web/console/src/app.tsx:241`）展示 message 与 next，但 next 指向的动作无处落地。

### 2.4 云端文件管理现状（2026-11-28 专项检查）

结论：**云端文件管理完全未实现，需从零建**。

| 检查项 | 结果 | 证据 |
| ------ | ---- | ---- |
| 上传接口 | 无 | 全仓无 multipart/FormData 处理；`POST /files/upload` 是 `IMPLEMENTATION_PLAN.md:73` 的未勾选项 |
| 下载/列表/删除接口 | 无 | 测试明确断言 `/files/papers/a.pdf` → 404（`web/functions/test/commands.test.ts:336`，"未知路径仍然 404"） |
| 平台存储调用 | 无 | `QODER_STORAGE` 只出现在 env 探针名单（`web/functions/routes.ts:80`），全仓零调用 |
| `cloud_file_node` 表 | 仅投影 | `web/migrations/0004_agent_reported_state.sql:40`：本地 Agent 上报的 path/kind/size 元数据，**不存文件内容**，只读 |
| `file_delete` 等文件命令 | 已删除 | 云端化重构移除（`docs/web-console/CLOUD_NATIVE_REFACTOR_PLAN.md:192`）；残留的 404≠400 断言是当前 10 个既有失败测试之一 |
| 前端入口 | 无 | 无上传组件；材料页横幅自述"上传……尚未接通" |

因此论文材料（文本）与文件管理（二进制）是同一条供给侧链路的两个粒度：材料中心解决"论文分析要文本"，文件管理解决"文件本体在哪存、怎么传、怎么列、怎么取"。两者共用一次鉴权、限额与审计设计。

### 2.5 既有文档承诺

`docs/web-console/REQUIREMENTS_ANALYSIS_WEB_FIRST.md:142`（F4 输入管理）、`IMPLEMENTATION_PLAN.md:73-77`（`POST /files/upload`、`DELETE /files/:path`、`GET /files/:path`、`GET /files/list`，单文件 500MB）均已规划但未勾选；`VISUAL_REVIEW_2026-11-25.md` 第 9 项明确"上传、文件存储和下载未接通"。

## 3. 用户与场景

角色仅两类（沿用 `docs/web-console/REQUIREMENTS.md` §2）：

- **所有者（Owner）**：提供、管理材料，触发恢复。
- **L2/游客（只读）**：只能看到已提供材料的清单与状态，看不到正文。

核心场景：

- **S1 首次阻断补充**：运行卡在 PAPER_ANALYSIS → 阻断卡片给出"补充论文"按钮 → 粘贴正文或摘要 → 自动恢复继续分析。
- **S2 提前准备**：创建项目后、开始运行前，先在材料中心登记论文。
- **S3 查缺口**：在阶段详情看到"需要：论文正文或摘要；已有：无"，点击直达提供表单。
- **S4 管理**：分析未消费的材料可替换/删除；已被任务消费的只读并标注消费方。

## 4. 功能需求

### P0（本期必须）

- **F1 提供入口**：三处入口指向同一表单——① 阻断卡片；② 材料与成果页；③ 论文分析阶段详情的缺口行。
- **F2 提供形式**：粘贴正文或摘要（文本，P0）；文件上传 PDF 见 P1。
- **F3 已提供清单**：材料列表展示标题（或首行摘要）、类型、字数/大小、提供时间、状态（待消费/已消费/已失效）、被哪个任务消费。
- **F4 管理**：未消费材料可替换、删除；已消费材料只读。
- **F5 恢复闭环**：提供材料后写入 queued `analyze_paper` 任务的 payload，调用 `/app/step` 复用 `step-driver.ts:90-94` 的既有自动解阻逻辑。
- **F6 缺口可视化**：阶段详情按"需要 / 已有 / 缺少"三态展示输入清单，缺少时内联"去提供"动作。

### P1（后续）

- **F7 文件上传**：PDF 上传 + 服务端提取文本（依赖 F10 文件管理底座）。
- **F8 数据集与代码包**：同一材料中心扩展 kind，不在本期范围。

### 云端文件管理（F9–F12，与 M0 同期打底）

- **F9 文件上传**：`POST /projects/:id/files`，multipart，路径白名单（`papers/`、`datasets/`、`reports/`），单文件限额。
- **F10 存储底座**：优先平台 `QODER_STORAGE`（先做只读探针 spike，env 有名字 ≠ 能取值，见 `routes.ts:79-84` 教训）；不可用则降级为 DB 存小文件（≤1 MB）并如实标注能力边界。
- **F11 文件读取**：`GET /files/list` 列目录、`GET /files/:path` 下载、`DELETE /files/:path` 删除（未被引用才可删），全部 Owner 鉴权 + 路径越界防护（`isSafeRelativePath` 复用）。
- **F12 文件与材料联动**：上传的 PDF 可在材料中心被选中触发 M1 提取，提取出的文本走 F5 同一恢复链路。

### 非功能需求

- **权限**：写操作仅 Owner（复用现有会话鉴权）；只读角色可见清单不可见正文与文件内容。
- **数据分级**：公开项目的材料默认不公开正文；材料与文件内容不进 Git、不进事件摘要明文。
- **限额**：单条文本上限（建议 200 KB）、单文件上限由服务端 capability 下发（请求体 8 MiB 安全线为硬约束：平台存储底座 7 MiB / 内置存储底座 1 MiB，见概要设计 §3.5；500 MB 属 `IMPLEMENTATION_PLAN.md` 远期目标）、每项目材料/文件数上限，超出返回 `invalid_input`。
- **路径安全**：所有文件路径过 `isSafeRelativePath`（`web/functions/commands.ts:1102` 既有实现），拒绝 `..`、绝对路径、符号链接逃逸。
- **审计**：材料与文件的创建/消费/删除各记一条事件，进"运行"面事件流。
- **诚实性**：材料状态如实标注（未消费就是未消费），不因提供材料就声称分析已完成。

## 5. 验收标准

1. 阻断状态下，从阻断卡片两次点击内到达可提交的提供表单。
2. 提交后 `/app/step` 使 `paper_input_required` 解除，分析任务进入 claimed/running（用 fake-db + 真实 step 流测试证明）。
3. 材料清单正确区分待消费/已消费，删除待消费材料成功、删除已消费材料被拒（409/`invalid_input`）。
4. 只读角色看不到正文字段，写接口对其返回 403。
5. 超限文本被拒并返回明确错误码。
6. 前端组件测试覆盖 F1/F3/F6；后端测试覆盖 F4/F5 与权限、限额、失败路径。
7. **文件管理**：上传 → list 可见 → 下载内容一致 → 删除后 list 不可见，全链路 Owner 鉴权；`../`、绝对路径返回 400；非 Owner 403；超限 400。
8. 存储底座能力边界如实呈现：探针结果与降级状态在文档与（可获得时）界面中注明，不假装平台存储可用。

## 6. 边界与非目标

- 不做数据集/代码包接入（F8 另立需求）。
- 不做文件内容的在线预览渲染（下载原始字节即可，预览属后续）。
- 不做分片/断点续传（`IMPLEMENTATION_PLAN.md` 的分片目标留待单文件限额被真实突破后再做）。
- 不改变"云端不是权威、投影单向"的既有架构约束（`REQUIREMENTS.md` §3.2）：材料与文件是用户输入，不是执行结果。
- 不实现多格式论文解析管线；本期只解决"文本正文/摘要"的提供与消费，PDF 提取属 M1。
