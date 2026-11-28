# 论文材料与云端文件管理 — 概要设计

日期：2026-11-28　依赖：`REQUIREMENTS_ANALYSIS_PAPER_MATERIAL.md`、`BLUEPRINT_PAPER_MATERIAL.md`　状态：设计阶段，未实现

## 1. 范围

- **M0b（F1–F6）**：文本材料的登记、清单、管理、回填恢复与缺口可视化。
- **M0a（F9–F11）**：云端文件管理底座——FileStore 适配器 + 上传/列表/下载/删除（现状为零实现，见需求分析 §2.4）。
- 不含：PDF 提取（M1）、数据集/代码包（M2）、分片续传。

## 2. 数据模型

新迁移 `web/migrations/0008_material_and_file.sql`（含 `cloud_material` 与 `cloud_file` 两表）：

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
  status            text NOT NULL DEFAULT 'pending',  -- pending|consumed|superseded
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
  status            text NOT NULL DEFAULT 'ready',  -- ready|superseded
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

处理（单事务）：

1. 鉴权：会话 + 项目 Owner（复用 `/projects` 写路由的鉴权路径，`routes.ts:528`）。
2. 限额：`content` trim 后 ≤ 200 KB；项目下未删除材料 ≤ 50 条 → 超出 `invalid_input:*` 400。
3. upsert 材料行（content_hash 幂等）。
4. 若 `run` 指定或项目存在 `paper_input_required` 阻断的 run：把 content 回填到该 run 全部 `status='queued'` 的 `analyze_paper` 任务 `payload`（`paper_text` 或 `abstract`，按 kind），`UPDATE … SET payload = payload || $1 WHERE kind='analyze_paper' AND status='queued'`。
5. 返回 `{ material, backfilled_tasks: n }`。

前端随后调用既有 `POST /app/step` 完成解阻（`step-driver.ts:90-94` 零改动）。

### 3.2 `GET /functions/v1/app/views/materials?external_id=…`（新增）

返回材料清单。**正文脱敏规则**：Owner 返回 `content_preview`（前 200 字）；只读角色不返回 `content`/`content_preview`，只返回 `title`、`kind`、`content_bytes`、`status`、`consumed_task_id`、`created_at`。错误形状沿用现有 `{"error": …, "request_id": …}`。

### 3.3 `DELETE /functions/v1/app/materials/:external_material_id`（新增，Owner）

- `status='pending'` → 置 `superseded`（软删，保留审计），200。
- `status='consumed'` → 409 `invalid_input:already_consumed`（F4 约束）。

### 3.4 云端文件管理四路由（新增，全部 Owner）

| 路由 | 行为 |
| ---- | ---- |
| `POST /projects/:external_id/files` | multipart 上传。字段 `file` + 可选 `path`（缺省 `papers/<sanitized-name>`）。校验：路径过 `isSafeRelativePath` 且前缀 ∈ 白名单 {`papers/`,`datasets/`,`reports/`}；大小 ≤ 10 MB（常量）；MIME ∈ {`application/pdf`,`text/plain`,`text/csv`,`application/json`}。同 `(project, path)` 覆盖：旧行置 superseded、新行 ready，`storage_backend` 记实际底座。 |
| `GET /views/files?external_id=…` | 清单：path/original_name/size/mime/storage_backend/status/referenced_count/created_at；只读角色可见清单（元数据），不可见内容。 |
| `GET /files/:path(*)` | 下载。按 `(project_id, path)` 查行 → 取 `storage_backend+storage_key` → 适配器读字节 → `Content-Disposition: attachment`。行不存在或 superseded → 404。**不接受用户输入直接参与存储寻址。** |
| `DELETE /files/:path(*)` | `referenced_count > 0` → 409 `invalid_input:file_referenced`；否则适配器删字节 + 行置 superseded。 |

### 3.5 `FileStore` 适配器（新 `web/functions/storage.ts`）

```ts
interface FileStore {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  backend: 'qoder_storage' | 'db';
}
```

- `createFileStore(db)`：先跑只读探针（`QODER_STORAGE` 可取值且最小 put/get 往返成功）→ `qoder_storage` 实现；否则 `db` 实现（`app.cloud_file` 同行存 blob，≤1 MB 上限，M0 上传限额 10 MB 中超出部分明确报 `invalid_input:storage_capacity`，不静默截断）。
- 探针结果在启动时确定一次并写日志；`cloud_file.storage_backend` 逐行记录，读写始终按行内 backend 分派，允许迁移期两种底座并存。
- 平台 SDK 调用方式待 spike 确认（`routes.ts:79-84` 教训：env 有名字 ≠ 能取值），spike 未过则 M0 全量走 db 底座并如实标注。

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
- 文件上传 → `POST files`（`FormData`，带 XSRF/会话 cookie 与既有 fetch 同栈）→ invalidate 新 `views/files`。
- 下载走 `<a href={/files/...} download>` 原生导航（带会话 cookie），不经过 fetch blob，避免大文件占 JS 内存。
- 缺口行/阻断卡的 `[去提供]` 打开同一弹层（复用材料页内表单组件，带 `autoFocus`），不新增路由。
- 状态 chip 复用 `.status-chip[data-state]`：`pending`→`active`、`consumed`→`ok`、`superseded`→`muted`。
- 正文展示复用 `expandable-text.tsx`（默认预览 + 键盘展开）。

### 4.3 错误路径

| 场景 | 展示 |
| ---- | ---- |
| 401/403 | 既有凭据失败提示（`auth.tsx`），表单保留输入 |
| 400 超限（文本） | 字段级错误"超出 200 KB 上限"，不清空 textarea |
| 400 超限/类型拒（文件） | 行内错误"单文件最大 10 MB，支持 PDF/TXT/CSV/JSON"，保留已选文件 |
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
11. 限额与类型：>10MB 400、MIME 不在白名单 400。
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

1. **存储 spike + FileStore**：只读探针脚本 + `storage.ts` 适配器 + db 底座，测试 14（降级）。
2. **文件迁移 + 四路由**：0008 迁移（两表）、上传/列表/下载/删除，测试 8–13。
3. **材料迁移 + 模型**：`materials.ts` 的 upsert/限额/脱敏读，测试 1–5、7。
4. **回填 + 恢复**：写路由接回填与 step 触发，测试 6（恢复闭环）。
5. **视图**：`views/materials` + `views/files` + `views/stage.input_checklist` + `block_detail.can_supply`，测试 4。
6. **前端材料中心**：`materials.tsx` + `files.tsx` + `Resources` 三区重构，测试 15–16、19。
7. **三入口接线**：阻断卡、阶段详情缺口行，测试 17–18。
8. **浏览器旅程**：S1 + S4 端到端 + 文档（PROGRESS 更新）。

切片 1–2（文件底座）与 3–5（文本材料）互不依赖，可并行。

## 8. 开放问题

1. `content` 是否允许跨 run 复用（同项目第二次 run 是否自动回填）——倾向：自动回填所有 queued 任务，M0 按"指定 run 或阻断 run"实现，行为写进测试。
2. 软删材料/文件的字节是否物理清除——M0 保留（审计需要），归档策略随 M2 存储方案一起定。
3. M1 的 PDF 提取放函数侧还是 worker 侧——待 FileStore spike 后定，不影响 M0 契约。
4. 只读角色能否下载文件字节——倾向：公开项目中"被引用"的文件可下载（否则成果陈列的文件引用无落地），私有项目仅 Owner；在切片 2 前定案并写进测试 10。
