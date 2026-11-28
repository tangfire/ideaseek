# 论文材料与云端文件管理 — 概要设计

日期：2026-11-28　依赖：`REQUIREMENTS_ANALYSIS_PAPER_MATERIAL.md`、`BLUEPRINT_PAPER_MATERIAL.md`　状态：设计阶段，未实现

## 1. 范围

- **M0b（F1–F6）**：文本材料的登记、清单、管理、回填恢复与缺口可视化。
- **M0a（F9–F11）**：云端文件管理底座——FileStore 适配器 + 上传/列表/下载/删除（现状为零实现，见需求分析 §2.4）。
- 不含：PDF 提取（M1）、数据集/代码包（M2）、分片续传。

## 2. 数据模型

新迁移 `web/migrations/0008_material_and_file.sql`（含 `cloud_material`、`cloud_file` 与可选 `cloud_file_blob` 三表；**受管 DDL 子集：无 CHECK/触发器/数组/numeric/事务/部分索引**，`CLOUD_NATIVE_REFACTOR_PLAN.md:221`——`DEFAULT gen_random_uuid()`/`DEFAULT now()` 沿用 0007 既有写法（accounts 流程已证实可用），其余初值（如 `status`）在 Function 代码里显式生成，不依赖未证实的默认值行为；迁移经平台 `create_database_migration`/`apply_database_migration` 受管工具执行，SQL 文件是契约记录，见 `SCHEMA_DRIFT.md:15`）：

```sql
CREATE TABLE app.cloud_material (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES app.cloud_project(id),
  external_material_id text NOT NULL,
  kind              text NOT NULL,              -- paper_text|paper_abstract（M0 白名单）
  title             text,                       -- 用户标注或首行摘要
  content           text NOT NULL,              -- 正文/摘要；只读角色视图不返回
  content_bytes     integer NOT NULL,
  content_hash      text NOT NULL,              -- sha256，幂等与去重
  status            text NOT NULL,                  -- pending|consumed|superseded（初值由代码生成）
  consumed_task_id  uuid REFERENCES app.cloud_task(id),
  source_file_id    uuid,                       -- 由文件提取而来时指向 cloud_file（M1）
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_material_id)
);
CREATE INDEX ON app.cloud_material (project_id, status);

CREATE TABLE app.cloud_file (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES app.cloud_project(id),
  external_file_id  text NOT NULL,
  path              text NOT NULL,              -- 项目内相对路径，isSafeRelativePath 校验
  original_name     text NOT NULL,
  size              bigint NOT NULL,
  content_hash      text NOT NULL,              -- sha256
  mime_type         text,
  storage_backend   text NOT NULL,              -- qoder_storage|db（如实记录实际底座）
  storage_key       text NOT NULL,              -- 平台存储 key 或 db 行引用
  status            text NOT NULL,              -- ready|superseded（初值由代码生成）
  referenced_count  integer NOT NULL DEFAULT 0, -- 被材料/任务引用计数，>0 拒删
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_file_id),
  UNIQUE (project_id, path)                     -- 同路径覆盖上传（见 3.5）
);
CREATE INDEX ON app.cloud_file (project_id, status);
```

要点：

- **材料与任务解耦**：一条材料可被回填进一个任务；`consumed_task_id` 记录消费方，支撑 F3 状态与 F4 只读约束。
- **正文集中在材料表**：`cloud_paper_card` 维持书目元数据不动（0001 注释约定）；`cloud_task.payload` 仍按既有契约存 `paper_text`/`abstract` 供 `paperInput()` 消费——两处是"登记副本"与"消费副本"，回填时以材料表为源生成。
- **幂等**：`(project_id, content_hash)` 重复提交返回已有材料而非报错（重复点击是常态）。
- **`cloud_file` 与既有 `cloud_file_node` 分工**：`cloud_file_node`（0004）是本地 Agent 上报的只读投影，保持不动；`cloud_file` 是云端自有的内容登记表，`storage_backend` 字段如实记录文件实际落在哪个底座，不假装平台存储可用。
- **`storage_key` 不是路径拼接**：下载/删除一律按行取出 `storage_backend + storage_key` 走适配器，用户输入的 `path` 只用于 list 展示与白名单校验，不参与存储寻址（防路径注入）。

`external_material_id` 生成规则：`mat-<8hex>`；`external_file_id`：`file-<8hex>`，与 `proj-`/`run-` 前缀风格一致。

## 3. 接口设计

### 3.1 `POST /functions/v1/app/projects/:external_id/materials`（新增，Owner）

请求：

```jsonc
{
  "kind": "paper_text",           // paper_text | paper_abstract
  "content": "……",                // 必填，trim 后非空
  "title": "可选标注",
  "run": "run-089750ea-3cf"       // 可选：指定回填到哪个 run 的 queued 任务
}
```

处理（**幂等两步，无事务**——平台明示"多次 SDK 调用不是一个事务，不存在 Function 侧事务 API、advisory lock、自定义 SQL/RPC"，见 `CLOUD_NATIVE_REFACTOR_PLAN.md:113`；两步的失败恢复靠幂等而非原子性）：

1. 鉴权：会话 + 项目 Owner（复用 `/projects` 写路由的鉴权路径，`routes.ts:528`）。
2. 限额：`content` trim 后 ≤ 200 KB；项目下未删除材料 ≤ 50 条 → 超出 `invalid_input:*` 400。
3. **第一步（幂等）**：按 `(project_id, content_hash)` upsert 材料行——重复提交返回已有材料，第一步无论重试多少次结果一致。
4. **第二步（幂等回填，读-改-写 + CAS）**：查出目标 run 全部 `status='queued'` 的 `analyze_paper` 任务 → 代码内合并 payload（`{...payload, paper_text|abstract: content}`，**不写 SQL 表达式**，平台无自定义 SQL/RPC）→ 条件更新 `.eq('id', …).eq('status', 'queued')` 并**核对返回行**（`CLOUD_NATIVE_REFACTOR_PLAN.md` 硬规则 2）；返回空行说明任务状态已变，跳过即可。合并语义幂等：重放同一条材料得到同一 payload。
5. 返回 `{ material, backfilled_tasks: n }`。第一步成功第二步失败时，材料已存在，**重新 POST 同一材料即完成回填**（靠 content_hash 幂等重放），无需补偿事务。

前端随后调用既有 `POST /app/step` 完成解阻（`step-driver.ts:90-94` 零改动）。注意：恢复依赖页面开着——step 由浏览器泵驱动，关页即停（既有产品语义，非本设计引入）。

### 3.2 `GET /functions/v1/app/views/materials?external_id=…`（新增）

返回材料清单。**正文脱敏规则**：Owner 返回 `content_preview`（前 200 字）；只读角色不返回 `content`/`content_preview`，只返回 `title`、`kind`、`content_bytes`、`status`、`consumed_task_id`、`created_at`。错误形状沿用现有 `{"error": …, "request_id": …}`。

### 3.3 `DELETE /functions/v1/app/materials/:external_material_id`（新增，Owner）

- `status='pending'` → 置 `superseded`（软删，保留审计），200。
- `status='consumed'` → 409 `invalid_input:already_consumed`（F4 约束）。

### 3.4 云端文件管理四路由（新增，全部 Owner）

| 路由 | 行为 |
| ---- | ---- |
| `POST /projects/:external_id/files` | multipart 上传（**multipart 解析能力未验证，属切片 0 spike**；若网关/运行时不支持 multipart，降级为 `Content-Type: application/octet-stream` + `X-File-Path` 头传元数据）。字段 `file` + 可选 `path`（缺省 `papers/<sanitized-name>`）。校验：路径过 `isSafeRelativePath` 且前缀 ∈ 白名单 {`papers/`,`datasets/`,`reports/`}；**大小 ≤ 服务端 capability 下发的 `max_file_bytes`（见 §3.5，请求体 8 MiB 安全线是硬约束，`CLOUD_NATIVE_REFACTOR_PLAN.md:216`）**；MIME ∈ {`application/pdf`,`text/plain`,`text/csv`,`application/json`}。同 `(project, path)` 覆盖：旧行置 superseded、新行 ready，`storage_backend` 记实际底座。 |
| `GET /views/files?external_id=…` | 清单 + capability：`max_file_bytes`、`storage_backend`（前端据此显示限额与底座徽标）；行字段 path/original_name/size/mime/storage_backend/status/referenced_count/created_at；只读角色可见元数据，不可见内容。 |
| `GET /files/:path(*)` | 下载。按 `(project_id, path)` 查行 → 取 `storage_backend+storage_key` → 适配器读字节 → `Content-Disposition: attachment`。行不存在或 superseded → 404。**不接受用户输入直接参与存储寻址。** 鉴权走 `x-ideaseek-session` 请求头（网关剥 cookie，见 memory/`gateway-strips-cookie-header`），故不能用原生 `<a>` 直链，见 §4.2。 |
| `DELETE /files/:path(*)` | `referenced_count > 0` → 409 `invalid_input:file_referenced`；否则适配器删字节 + 行置 superseded。 |

### 3.5 `FileStore` 适配器（新 `web/functions/storage.ts`）

```ts
interface FileStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  backend: 'qoder_storage' | 'db';
  maxFileBytes: number;   // 下发到 /views/files 的 capability
}
```

- `createFileStore(db)`：先跑只读探针（`QODER_STORAGE` 可取值且最小 put/get 往返成功）→ `qoder_storage` 实现；否则 `db` 实现（字节存独立 blob 表，见下）。
- **限额由底座决定并如实下发**（消除前一版"10 MB 上传 vs 1 MB DB 容量"的自相矛盾）：
  - `qoder_storage` 底座：`maxFileBytes = 7 MiB`（请求体 8 MiB 安全线，`CLOUD_NATIVE_REFACTOR_PLAN.md:216`；实测 16 MiB 是连接级硬失败，不给重试留空间）；
  - `db` 底座：`maxFileBytes = 1 MiB`（blob 行与元数据同行，避免撑爆请求体与行宽）。
  - 前端从 `views/files` 读 capability 显示"单文件最大 X"，**不写死 10 MB**。
- 探针结果在启动时确定一次并写日志；`cloud_file.storage_backend` 逐行记录，读写始终按行内 backend 分派，允许迁移期两种底座并存。
- **`db` 底座的 blob 存储位置**：独立 `cloud_file_blob(file_id uuid PK, data bytea)` 表而非元数据行内——受管 DDL 是否允许 `bytea`/大 text **未验证**，若被拒则降级 base64 text（1 MiB 文件 ≈ 1.4 MB 文本，仍在安全线内），两条路都写进 spike 验收。
- 平台 SDK 调用方式待 spike 确认（`routes.ts:79-84` 教训：env 有名字 ≠ 能取值），spike 未过则全量走 db 底座并如实标注。

### 3.6 既有接口的改动

| 接口 | 改动 |
| ---- | ---- |
| `GET /views/stage` | 任务对象增加 `input_checklist: [{need, have: bool, material_id?, action}]`（由 task kind + payload 现值推导，纯读） |
| `GET /views/project` | `block_detail` 增加 `can_supply: true` 与 `material_kinds`，供阻断卡片渲染按钮 |
| `/app/step`、`paperInput()`、引擎 | **零改动** |

## 4. 前端设计（web/console/src）

### 4.1 组件

| 组件 | 文件 | 职责 |
| ---- | ---- | ---- |
| `MaterialForm` | 新 `materials.tsx` | kind 选择 + textarea + 字数计数 + 提交；提交成功后触发 step；三入口复用 |
| `MaterialList` | 新 `materials.tsx` | 材料卡：状态 chip、消费任务链接、未消费时 [替换][删除] |
| `FileUpload` | 新 `files.tsx` | `<input type=file>` + 拖放、路径前缀选择（papers/datasets/reports）、进度与错误；M0 仅 papers 前缀开放 UI |
| `FileList` | 新 `files.tsx` | 文件行：名称/大小/时间/底座徽标（`storage_backend` 如实显示"平台存储/内置存储"）/[下载][删除] |
| `BlockReasonCard` | `app.tsx:241` 改 | `can_supply` 时渲染 `[补充论文]` 主按钮 → 打开表单（弹层或材料页锚点） |
| `Resources` | `resources.tsx` 改 | 拆为"材料中心（上，可写：文本材料卡组 + 文件清单）+ 成果陈列（下，只读）"三区 |
| `StageDetails` | `stage-details.tsx` 改 | 输入清单三态行 + `[去提供]` 内联动作 |

### 4.2 状态与交互

- 表单提交 → `POST materials` → 读 `backfilled_tasks > 0` → 自动 `POST /app/step` → React Query invalidate `views/project` + `views/stage` + 新 `views/materials`。
- 文件上传 → `POST files`（`FormData`）→ invalidate 新 `views/files`。
- **下载不能用原生 `<a href>`**：会话是 `x-ideaseek-session` 请求头（localStorage 取，网关剥 cookie），`<a>`/`window.open` 带不了自定义头。改为 `fetch(/files/:path, {headers: sessionHeaders()})` → `response.blob()` → `URL.createObjectURL` → 临时 `<a download>` 触发 → `revokeObjectURL`。`api.ts` 现只解析 JSON（`api.ts:130`），需加一个 `fetchBinary` 辅助；文件 ≤ 7 MiB 在内存中转可接受。
- 缺口行/阻断卡的 `[去提供]` 打开同一弹层（复用材料页内表单组件，带 `autoFocus`），不新增路由。
- 状态 chip 复用 `.status-chip[data-state]`：`pending`→`active`、`consumed`→`ok`、`superseded`→`muted`。
- 正文展示复用 `expandable-text.tsx`（默认预览 + 键盘展开）。

### 4.3 错误路径

| 场景 | 展示 |
| ---- | ---- |
| 401/403 | 既有凭据失败提示（`auth.tsx`），表单保留输入 |
| 400 超限（文本） | 字段级错误"超出 200 KB 上限"，不清空 textarea |
| 400 超限/类型拒（文件） | 行内错误"单文件最大 {capability 下发值}，支持 PDF/TXT/CSV/JSON"，保留已选文件 |
| 400 路径越界 | 行内错误"路径必须位于 papers/、datasets/ 或 reports/ 下" |
| 409 已消费删除 / 文件被引用 | 行内提示，列表 refetch |
| step 失败 | 材料已登记成功，提示"材料已保存，恢复运行失败，点击重试 [重试]"——不回滚材料 |
| 存储底座降级 | 文件清单头部一条 muted 提示"当前使用内置存储（平台存储未接通）"，不假装 |

## 5. 权限与安全

- 写路由全部走会话鉴权 + Owner 判定，非 Owner 403（与 `/access/grants` 同路径模式）。
- `content` 与文件字节永不进：事件 summary、日志、错误栈、公开分享 payload（对齐 `docs/AGENTS.md` 数据约束）。
- 输入校验在函数边界：kind 白名单、content 类型与长度、external_material_id 形状（`mat-[0-9a-f]{8}`）、文件 path 过 `isSafeRelativePath` + 前缀白名单 + MIME 白名单——沿用 `commands.ts` 的 `text()`/`fail()` 校验风格。
- **存储寻址与用户输入分离**：`storage_key` 服务端生成（`file-<8hex>`），用户 path 不参与存储寻址（§2 要点）。
- 下载路由防路径注入：`GET /files/:path` 只按 `(project_id, path)` 精确查行，不做任何文件系统拼接。
- 限额硬编码常量并写进测试，不做动态配置（本期无配置系统）。

## 6. 测试计划

**后端材料**（`web/functions/test/materials.test.ts`，node:test + fake-db + `withSession`）：

1. Owner 登记成功，材料行与 `backfilled_tasks=1`。
2. 幂等：同 content 二次提交返回同一材料，不重复回填。
3. 限额：>200KB 400；第 51 条 400。
4. 权限：非 Owner 403；只读视图不含 `content`。
5. 删除：pending → superseded；consumed → 409。
6. 恢复闭环：阻断 run → 登记 → step → `block_reason` 清空、任务状态离开 queued（**关键回归**，钉住 `step-driver.ts:90-94` 契约）。
7. **真库语义测试**：按 0008 迁移文件核对列名/约束（吸取 3f4722a fake-db 放过不存在列的教训）。

**后端文件**（`web/functions/test/files.test.ts`）：

8. 上传 → list 可见 → 下载字节一致 → 删除后 list 不可见（全链路）。
9. 路径安全：`../`、绝对路径、白名单外前缀 → 400（对齐既有 `isSafeRelativePath` 断言风格，`commands.test.ts:143`）。
10. 权限：非 Owner 上传/删除 403、匿名 401；只读角色 list 可见但下载按分级拒绝或降级（按 §3.4 最终定）。
11. 限额与类型：超 `max_file_bytes` 400、MIME 不在白名单 400。
12. 覆盖语义：同 path 再上传 → 旧记录 superseded、新记录 ready、下载得新字节。
13. 引用保护：`referenced_count > 0` 删除 → 409。
14. FileStore 探针降级：平台存储不可用时 db 底座全链路可用，`storage_backend` 字段如实。

**前端**（`vitest.console.ts` 已有 include 模式）：

15. `MaterialForm`：提交、超限错误、成功后触发 step。
16. `Resources` 三区分区与状态 chip。
17. `StageDetails` 三态缺口行与 `[去提供]` 动作。
18. `BlockReasonCard` 有/无 `can_supply` 的按钮分支。
19. `FileUpload`/`FileList`：选中校验、错误行、底座徽标、下载链接形态。

**浏览器验收**（`web/console/test/*.browser.js` 既有风格）：20. 阻断 → 两步恢复的完整旅程（S1）；21. 文件上传 → 清单 → 下载 → 删除（S4）。

## 7. 实施切片（每片一个可验证提交）

0. **可行性 spike（先于一切，半天）**：四项一次验完，任一失败即触发 §9 对应降级——
   a. `QODER_STORAGE` 只读探针（env 取值 + 最小 put/get 往返）；
   b. 受管迁移建临时表测 `bytea`/大 text 是否被 DDL 子集接受；
   c. 函数内 `request.formData()` multipart 解析（平台网关是否放行 multipart content-type）；
   d. 8 MiB 内请求体实测回读（复用 `/probe/body` 观测口径）。
1. **存储 spike + FileStore**：`storage.ts` 适配器 + db 底座，测试 14（降级）。
2. **文件迁移 + 四路由**：0008 迁移（两表）、上传/列表/下载/删除，测试 8–13。
3. **材料迁移 + 模型**：`materials.ts` 的 upsert/限额/脱敏读，测试 1–5、7。
4. **回填 + 恢复**：写路由接回填与 step 触发，测试 6（恢复闭环）。
5. **视图**：`views/materials` + `views/files` + `views/stage.input_checklist` + `block_detail.can_supply`，测试 4。
6. **前端材料中心**：`materials.tsx` + `files.tsx` + `Resources` 三区重构，测试 15–16、19。
7. **三入口接线**：阻断卡、阶段详情缺口行，测试 17–18。
8. **浏览器旅程**：S1 + S4 端到端 + 文档（PROGRESS 更新）。

切片 3–5（文本材料）不依赖 spike，可与 0–2 并行先行；**文本材料链路是演示的最小闭环，文件链路是其扩展，任何文件侧降级都不影响 S1 演示**。

## 8. 开放问题

1. `content` 是否允许跨 run 复用（同项目第二次 run 是否自动回填）——倾向：自动回填所有 queued 任务，M0 按"指定 run 或阻断 run"实现，行为写进测试。
2. 软删材料/文件的字节是否物理清除——M0 保留（审计需要），归档策略随 M2 存储方案一起定。
3. M1 的 PDF 提取放函数侧还是 worker 侧——待 FileStore spike 后定，不影响 M0 契约。
4. 只读角色能否下载文件字节——倾向：公开项目中"被引用"的文件可下载（否则成果陈列的文件引用无落地），私有项目仅 Owner；在切片 2 前定案并写进测试 10。

## 9. 悲观可行性复核（2026-11-28）

对设计逐条对照平台已证实约束，结论：**文本材料链路（S1）高可行；文件链路可行但受三个平台未知数约束，全部有降级路径；无一项被证伪。**

### 9.1 复核中发现并已修正的硬伤（本版已改）

| # | 原设计 | 冲突证据 | 修正 |
| - | ------ | -------- | ---- |
| 1 | "处理（单事务）"、"回填在同一事务里完成" | 平台**无事务**：`CLOUD_NATIVE_REFACTOR_PLAN.md:113`"多次 SDK 调用不是一个事务，不存在 Function 侧事务 API/advisory lock/自定义 SQL/RPC" | 改为幂等两步 + 读改写 CAS（硬规则 2），失败靠 content_hash 幂等重放恢复 |
| 2 | `UPDATE … SET payload = payload \|\| $1`（SQL 表达式） | 同上：**无自定义 SQL/RPC** | 改为代码内合并 payload + 条件更新 + 核对返回行 |
| 3 | 单文件 10 MB | 请求体 **8 MiB 安全线**、16 MiB 连接级硬失败（`:216`）；10 MB 越线 | 限额改由 FileStore capability 下发：storage 底座 7 MiB / db 底座 1 MiB，前端不写死 |
| 4 | 下载用 `<a href download>`（会话 cookie） | 会话是 `x-ideaseek-session` **请求头**且网关剥 cookie（memory `gateway-strips-cookie-header`）；`<a>` 带不了自定义头 | 改 fetch→blob→objectURL，`api.ts` 加 `fetchBinary` |
| 5 | 迁移 SQL 直接执行 | 受管迁移走平台 `create_database_migration`/`apply_database_migration`（`SCHEMA_DRIFT.md:15`）；DDL 无 CHECK/触发器/部分索引（`:221`） | SQL 文件定位为契约记录；状态初值不依赖 DDL DEFAULT，代码生成 |
| 6 | 测试计划未提 fake-db 局限 | fake-db 无 schema 校验（3f4722a 教训）、`test:function` 脚本是**显式文件列表**（`package.json:33`）不含新测试文件 | 测试 7 已含真库语义核对；**落地时必须把新测试文件加进 `test:function`，否则 CI 根本不跑** |

### 9.2 仍未证实的平台未知数（全部有降级，spike 切片 0 逐项验证）

| 未知数 | 悲观预期 | 若失败的降级 | 对演示的影响 |
| ------ | -------- | ------------ | ------------ |
| `QODER_STORAGE` 可取值可往返 | 中等偏悲观（env 有名字≠能取值，`routes.ts:79-84` 前科） | db blob 底座（1 MiB），capability 如实下发 | 无：S1 文本链路不依赖文件 |
| DDL 接受 `bytea`/大 text | 乐观（0007 有 DEFAULT 先例，但 bytea 无先例） | base64 text 列（1 MiB 内） | 无 |
| 网关放行 multipart | 未知（全仓无先例，`/probe/body` 只测过 raw） | `octet-stream` + `X-File-Path` 头（已写进 §3.4） | 无 |
| `referenced_count` 无触发器维护 | 已知约束（无触发器） | 计数在写路径代码维护 + 删除前重查实际引用（宁可误拒不可误删） | 无 |
| 浏览器泵驱动 step | 已知产品语义（关页即停） | 演示脚本保持页面打开；文案已如实 | 演示需守此约束 |

### 9.3 复核后仍成立的关键判断

- **引擎零改动**判断不变：`step-driver.ts:90-94` 的解阻逻辑与 `paperInput()` 契约是仓内代码，非平台能力，悲观复核未动摇。
- **最小演示闭环**判断不变且更清晰：S1（阻断→粘贴→恢复）只依赖文本材料三路由，不依赖任何未证实的平台能力；文件链路即使 spike 全败也只剩 1 MiB db 存储。
- **最大真实风险**是集成面而非单点：受管 SDK 的 CAS 返回行行为（`CLOUD_NATIVE_REFACTOR_PLAN.md:216`"必须先核实受支持方对 affected-row 的真实行为"）——测试 6（恢复闭环）与测试 2（CAS 回填）必须打在真库语义上，fake-db 绿不算数。
