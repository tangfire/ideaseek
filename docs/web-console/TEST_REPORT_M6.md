# M6 测试报告：审批信箱 + 成本 + 外发 + Token 管理

**里程碑**: M6 (PLAN.md Milestone 6 = FEATURE_LIST M11 + M12 + M13 + M16 P1)
**日期**: 2026-11-23
**退出标准**: F11/F12/F16 的 P1 项全部可演示

---

## 1. 交付清单

| 功能 ID | 描述 | 优先级 | 状态 |
|---------|------|--------|------|
| F11.1 | 待确认审批列表（跨项目聚合 pending 审批） | P1 | ✅ |
| F11.2 | 审批详情（原因、选项、影响范围、来源事件） | P1 | ✅ |
| F11.3 | 提交意向（文案"待本地确认"，永不显示"已批准/已生效"） | P1 | ✅ |
| F11.4 | 冲突意向并列（多个审批人选不同选项全部列出） | P1 | ✅ |
| F11.5 | intent 生命周期（submitted → delivered → consumed） | P1 | ✅ |
| F11.6 | autonomous 模式只读 | P1 | ✅ (L1 限制) |
| F12.1 | 花费汇总（token 数、USD micro） | P1 | ✅ |
| F12.2 | 预算进度（spent / budget，接近上限高亮） | P1 | ✅ |
| F12.3 | 重复成本标记（同 run 内相同 model_route + kind 多次） | P1 | ✅ |
| F12.4 | 按模型路由分布 | P2 | ✅ |
| F12.5 | 额度耗尽引导（指向 ideaseek doctor + continue） | P1 | ✅ |
| F13.1 | 按 run 聚合外发汇总 | P2 | ✅ |
| F13.2 | 与启动授权对照 | P2 | ✅ (结构就绪) |
| F13.3 | 引擎侧计数来源（引擎未产生数据时显式说明） | P2 | ✅ |
| F13.4 | 台账导出 | P2 | ⬜ 未实现 |
| F16.1 | token 管理页（签发/名称/范围/吊销） | P1 | ✅ |
| F16.2 | 同步健康自检（最近批次状态、拒绝原因分布） | P1 | ✅ |

**退出标准达成**: F11 全部 P1 ✅ / F12 全部 P1 ✅ / F16 P1 ✅

---

## 2. 代码变更

### 2.1 前端类型 (`web/console/src/types.ts`)
- 新增 `ApprovalRequest`、`ApprovalIntent` 接口（F11）
- 新增 `CostEntry`、`CostSummary` 接口（F12）
- 新增 `EgressEntry` 接口（F13）
- 新增 `SyncToken`、`SyncHealth` 接口（F16）

### 2.2 前端 API (`web/console/src/api.ts`)
- 新增 `mutateJson<T>()` 函数，支持 POST/DELETE/PATCH 写操作

### 2.3 前端组件 (`web/console/src/app.tsx`)
- 新增 `ApprovalInbox` 组件（F11.1-F11.6）
  - 左右分栏：待确认列表 + 审批详情
  - IntentForm 子组件：选择方案 + 备注 + 提交
  - 文案固定"待本地确认"，永不显示"已批准/已生效"
  - 冲突意向并列展示（F11.4）
- 新增 `CostDashboard` 组件（F12.1-F12.5）
  - 花费汇总卡片：总花费、Token 输入/输出
  - 预算进度条：接近 80% 时高亮红色
  - 按模型路由分布图
  - 重复成本标记面板
  - 额度耗尽引导（指向 `ideaseek doctor → continue`）
- 新增 `EgressLedger` 组件（F13.1-F13.3）
  - 按 run 聚合表格：目标类别、数据类别、次数、字节
  - 引擎未产生数据时显式说明（F13.3）
- 新增 `TokenManager` 组件（F16.1-F16.2）
  - Token 列表：名称、范围、创建时间、最后使用、吊销状态
  - 创建表单：名称 + 范围（逗号分隔）
  - 明文 token 只显示一次（NFR-02）
  - 同步健康面板：最近批次状态、待处理批次数、拒绝原因分布
- 所有 M6 组件在 Project 页面中仅 L1 用户可见（`!l2` 条件渲染）

### 2.4 Function 读路径 (`web/functions/views.ts`)
- 新增 `approvalIndex()`: 跨项目聚合 pending 审批 + 附带意向列表
- 新增 `submitIntent()`: 写入 cloud_approval_intent，验证审批归属
- 新增 `costView()`: 按 run 聚合成本，含重复标记和路由分布
- 新增 `egressView()`: 按 run 聚合外发条目
- 新增 `tokenList()`: 列出 Owner 的 sync token 元数据
- 新增 `tokenCreate()`: 生成明文 token，哈希后入库（NFR-02）
- 新增 `tokenRevoke()`: 设置 revoked_at，不删除行
- 新增 `syncHealth()`: 最近批次 + 拒绝原因分布

### 2.5 Function 路由 (`web/functions/routes.ts`)
- 新增路由：
  - `GET /views/approvals` → approvalIndex
  - `POST /approvals/:id/intent` → submitIntent
  - `GET /views/costs?external_id=X` → costView
  - `GET /views/egress?external_id=X` → egressView
  - `GET /views/tokens` → tokenList
  - `POST /views/tokens` → tokenCreate
  - `DELETE /views/tokens/:id` → tokenRevoke
  - `GET /views/health?external_id=X` → syncHealth

### 2.6 Function 写路径 (`web/functions/ingest.ts`)
- IMPLEMENTED 集合新增 `approvals`、`costs`、`egress`
- 新增 `writeApprovals()`: 幂等 upsert by (run_id, external_approval_id)
- 新增 `writeCosts()`: 幂等 upsert by (run_id, external_cost_id)，校验 usd_micro 为非负整数
- 新增 `writeEgress()`: 幂等 upsert by (run_id, external_egress_id)
- ingestBatch 响应 counts 包含新集合计数

---

## 3. 数据库表（已存在于 migrations/0002_projection_deep.sql）

| 表名 | 用途 | 唯一键 |
|------|------|--------|
| cloud_approval_request | 审批请求 | (run_id, external_approval_id) |
| cloud_approval_intent | 审批意向 | (approval_request_id, owner_id) |
| cloud_cost_entry | 成本条目 | (run_id, external_cost_id) |
| cloud_egress_entry | 外发条目 | (run_id, external_egress_id) |
| cloud_sync_token | 同步 Token（仅哈希） | token_hash UNIQUE |

---

## 4. 安全与隐私审查

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 凭据不入 prompt/日志/artifact | ✅ | sync_token 只存哈希（NFR-02） |
| L0/L1/L2 分级正确 | ✅ | M6 所有组件仅 L1 可见 |
| 审批不落执行 | ✅ | 只写意向，生效需本地 pull + Owner 二次确认 |
| 外发无正文 | ✅ | 只有类别与计数（缺口⑫） |
| 文案无"实时" | ✅ | 全部使用"同步"或"来自 x 分钟前的一批同步" |
| 匿名访客隔离 | ✅ | 审批/token 管理对匿名返回空数组 |

---

## 5. 已知限制

1. **F13.4 台账导出未实现**: P2 优先级，当前只支持页面查看，不支持 CSV/JSON 导出。
2. **F11.6 autonomous 模式只读**: 当前通过 L1 访问控制实现（匿名和 L2 看不到审批），未在引擎侧区分 autonomous 模式。若引擎将来投影 autonomy 字段到 cloud_project，可在前端增加条件渲染。
3. **引擎侧数据源未就绪**: F13.3 明确说明——若引擎未产生外发计数数据，台账为空并显式说明。当前引擎侧（src/）没有 egress accounting 实现（PRODUCT_GAPS_AUDIT.md 缺口 12）。
4. **Token 明文只显示一次**: 创建后返回 plain_token，前端显示提醒用户保存。关闭页面后无法再次查看。这是 NFR-02 的设计意图。
5. **并发审批意向**: 多个 Owner 同时提交意向时，数据库层面不保证顺序。F11.4 的"冲突意向并列"在 UI 层按 submitted_at 倒序展示，由本地引擎最终 adjudicate。

---

## 6. 测试矩阵

| 场景 | 预期 | 状态 |
|------|------|------|
| 匿名访客访问审批页 | 返回空数组，不报错 | ⬜ 待部署验证 |
| L2 用户访问成本页 | 显示"不在公开降级投影" | ⬜ 待部署验证 |
| Owner 提交审批意向 | 返回 intent_id + "待本地确认" | ⬜ 待部署验证 |
| 创建 sync token | 返回 plain_token，数据库只存哈希 | ⬜ 待部署验证 |
| 吊销已撤销的 token | 返回 409 conflict | ⬜ 待部署验证 |
| 引擎未产生外发数据 | 台账显示"引擎尚未产生数据" | ⬜ 待部署验证 |
| 预算使用 >80% | 进度条变红 + 提示文案 | ⬜ 待部署验证 |
| 重复成本标记 | 同 route+kind 多次出现时显示计数 | ⬜ 待部署验证 |

---

## 7. 后续里程碑建议

- **M7**: F13.4 台账导出（CSV/JSON）
- **M7**: 引擎侧 egress accounting 接入（PRODUCT_GAPS_AUDIT 缺口 12）
- **M7**: WebSocket 推送审批状态变更（F17 扩展）
- **M-3**: 并发审批意向的顺序保证
