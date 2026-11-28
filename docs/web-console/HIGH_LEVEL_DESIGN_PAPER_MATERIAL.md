# 论文材料提供 — 概要设计

日期：2026-11-28　依赖：`REQUIREMENTS_ANALYSIS_PAPER_MATERIAL.md`、`BLUEPRINT_PAPER_MATERIAL.md`　状态：设计阶段，未实现

## 1. 范围

M0（F1–F6）：文本材料的登记、清单、管理、回填恢复与缺口可视化。不含文件上传（M1）、数据集/代码包（M2）。

## 2. 数据模型

新迁移 `web/migrations/0008_cloud_material.sql`：

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
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_material_id)
);
CREATE INDEX ON app.cloud_material (project_id, status);
```

要点：

- **材料与任务解耦**：一条材料可被回填进一个任务；`consumed_task_id` 记录消费方，支撑 F3 状态与 F4 只读约束。
- **正文集中在材料表**：`cloud_paper_card` 维持书目元数据不动（0001 注释约定）；`cloud_task.payload` 仍按既有契约存 `paper_text`/`abstract` 供 `paperInput()` 消费——两处是"登记副本"与"消费副本"，回填时以材料表为源生成。
- **幂等**：`(project_id, content_hash)` 重复提交返回已有材料而非报错（重复点击是常态）。

`external_material_id` 生成规则：`mat-<8hex>`，与 `proj-`/`run-` 前缀风格一致。

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

### 3.4 既有接口的改动

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
| `BlockReasonCard` | `app.tsx:241` 改 | `can_supply` 时渲染 `[补充论文]` 主按钮 → 打开表单（弹层或材料页锚点） |
| `Resources` | `resources.tsx` 改 | 拆为"材料中心（上，可写）+ 成果陈列（下，只读）"两区 |
| `StageDetails` | `stage-details.tsx` 改 | 输入清单三态行 + `[去提供]` 内联动作 |

### 4.2 状态与交互

- 表单提交 → `POST materials` → 读 `backfilled_tasks > 0` → 自动 `POST /app/step` → React Query invalidate `views/project` + `views/stage` + 新 `views/materials`。
- 缺口行/阻断卡的 `[去提供]` 打开同一弹层（复用材料页内表单组件，带 `autoFocus`），不新增路由。
- 状态 chip 复用 `.status-chip[data-state]`：`pending`→`active`、`consumed`→`ok`、`superseded`→`muted`。
- 正文展示复用 `expandable-text.tsx`（默认预览 + 键盘展开）。

### 4.3 错误路径

| 场景 | 展示 |
| ---- | ---- |
| 401/403 | 既有凭据失败提示（`auth.tsx`），表单保留输入 |
| 400 超限 | 字段级错误"超出 200 KB 上限"，不清空 textarea |
| 409 已消费删除 | 行内提示，列表 refetch |
| step 失败 | 材料已登记成功，提示"材料已保存，恢复运行失败，点击重试 [重试]"——不回滚材料 |

## 5. 权限与安全

- 写路由全部走会话鉴权 + Owner 判定，非 Owner 403（与 `/access/grants` 同路径模式）。
- `content` 永不进：事件 summary、日志、错误栈、公开分享 payload（对齐 `docs/AGENTS.md` 数据约束）。
- 输入校验在函数边界：kind 白名单、content 类型与长度、external_material_id 形状（`mat-[0-9a-f]{8}`）——沿用 `commands.ts` 的 `text()`/`fail()` 校验风格。
- 限额硬编码常量并写进测试，不做动态配置（本期无配置系统）。

## 6. 测试计划

**后端**（`web/functions/test/materials.test.ts`，node:test + fake-db + `withSession`）：

1. Owner 登记成功，材料行与 `backfilled_tasks=1`。
2. 幂等：同 content 二次提交返回同一材料，不重复回填。
3. 限额：>200KB 400；第 51 条 400。
4. 权限：非 Owner 403；只读视图不含 `content`。
5. 删除：pending → superseded；consumed → 409。
6. 恢复闭环：阻断 run → 登记 → step → `block_reason` 清空、任务状态离开 queued（**关键回归**，钉住 `step-driver.ts:90-94` 契约）。
7. **真库语义测试**：按 0008 迁移文件核对列名/约束（吸取 3f4722a fake-db 放过不存在列的教训）。

**前端**（`vitest.console.ts` 已有 include 模式）：

8. `MaterialForm`：提交、超限错误、成功后触发 step。
9. `Resources` 两区分区与状态 chip。
10. `StageDetails` 三态缺口行与 `[去提供]` 动作。
11. `BlockReasonCard` 有/无 `can_supply` 的按钮分支。

**浏览器验收**（`web/console/test/*.browser.js` 既有风格）：12. 阻断 → 两步恢复的完整旅程（S1）。

## 7. 实施切片（每片一个可验证提交）

1. **迁移 + 模型**：0008 迁移、`materials.ts` 的 upsert/限额/脱敏读，测试 1–5、7。
2. **回填 + 恢复**：写路由接回填与 step 触发，测试 6（恢复闭环）。
3. **视图**：`views/materials` + `views/stage.input_checklist` + `block_detail.can_supply`，测试 4。
4. **前端材料中心**：`materials.tsx` + `Resources` 两区重构，测试 8–9。
5. **三入口接线**：阻断卡、阶段详情缺口行，测试 10–11。
6. **浏览器旅程**：S1 端到端 + 文档（PROGRESS 更新）。

## 8. 开放问题

1. `content` 是否允许跨 run 复用（同项目第二次 run 是否自动回填）——倾向：自动回填所有 queued 任务，M0 按"指定 run 或阻断 run"实现，行为写进测试。
2. 软删材料的 `content` 是否物理清除——M0 保留（审计需要），归档策略随 M2 存储方案一起定。
3. M1 的 PDF 提取放函数侧还是 worker 侧——待 QODER_STORAGE spike 后定，不影响 M0 契约。
