# M3 测试报告：核心观测 UI + 实时推送通道完善

**日期**：2026-11-23  
**分支**：`feat/web-console`  
**里程碑**：M3（核心观测 UI + 实时推送通道）

---

## 1. 交付内容

### 1.1 项目详情页增强（F2.3-F2.5）

**文件**：`web/console/src/app.tsx`

- **F2.3 运行历史列表**：`RunHistory` 组件展示一个 project 的多次 run，含终态与耗时
  - 按 `started_at` 倒序排列
  - 显示运行 ID（截断前 8 字符）、阶段、状态、开始时间、耗时
  - L2 降级下 status 不可见，显示"不在公开级"
  - 耗时格式化为 ms/s/min/h

- **F2.4 异常态显性化**：`BlockReasonCard` 组件将基础设施问题与科学失败视觉分离
  - `QUOTA_EXHAUSTED`/`AUTH_REQUIRED`/`NETWORK_BLOCKED` 渲染为紫色（`--quota`）+ "基础设施阻塞"
  - 其他阻塞渲染为黄色（`--blocked`）+ "等待确认"
  - 文案明确区分："额度已用尽 · 不是运行失败"（F2.4 核心要求）

- **F2.5 阻塞原因卡**：说清卡在哪、等什么、下一步建议
  - 显示 `block_reason` 或 `block_detail.message`
  - 从 `status` 推导 `next` 建议（`deriveNextFromReason`）：
    - `QUOTA_EXHAUSTED` → "ideaseek doctor → 检查额度 → ideaseek continue"
    - `AUTH_REQUIRED` → "ideaseek setup → 配置凭据 → ideaseek continue"
    - `NETWORK_BLOCKED` → "检查网络连接 → ideaseek continue"
    - `USER_INPUT_REQUIRED` → "ideaseek attach → 回应提示"
    - `PROTOCOL_REVIEW` → "ideaseek pending → 查看待确认协议"

### 1.2 阶段流水线图完善（F3.1-F3.4）

**文件**：`web/console/src/app.tsx`

- **F3.1 14阶段流水线图**：`STAGES` 常量严格对齐 `WORKFLOW_SPEC.md:5-21`
  - INIT → INPUT_READY → CALIBRATING → PAPER_ANALYSIS → DATA_READY → PROTOCOL_PROPOSED → PROTOCOL_REVIEW → COMPARISON_DISCOVERY → COMPARISON_REPRODUCTION → BASELINE_VALIDATED → IDEA_GENERATION → IDEA_SCREENING → EXPERIMENTING → IDEA_REVIEW → COMPLETED
  - 不增删改名（NFR-12）

- **F3.2 阶段状态渲染**：五态 `pending`/`active`/`blocked`/`passed`/`failed`
  - 使用 `status-chip` 组件 + `data-state` 属性
  - 颜色映射：ok=绿、active=蓝、blocked=黄、fail=红、quota=紫、idle=灰

- **F3.3 门槛达成说明**：可折叠的详情区块
  - 显示每个阶段的 `gate_note`（进入条件与当前证据）
  - 显示 `blocker_code`（阻塞码）
  - 只有存在门槛说明时才渲染

- **F3.4 unknown 阶段兜底**：显式标注"未上报"
  - `stage_known=false` 的阶段在 chip 上显示"（未上报）"
  - 底部注释说明："标记为'未上报'的阶段是引擎尚未投影到 14 阶段模型的中间状态"

### 1.3 时间线视图（F4.1-F4.4）

**文件**：`web/console/src/app.tsx`

- **F4.1 时间线视图**：事件按 seq 倒序，分页 200
  - `pageSize=200`，支持上一页/下一页导航
  - 显示总事件数与过滤后数量

- **F4.2 事件过滤**：按 stage / type / level 过滤
  - 三个下拉选择器：阶段、类型、级别
  - 动态提取唯一值作为选项
  - "清除过滤"按钮重置所有过滤器
  - `actor_role` 当前引擎未投影，留接口

- **F4.3 摘要展示与截断标记**：≤400 字符，截断可见
  - `event.truncated=true` 时显示 "…（已截断）"
  - hover 提示："摘要被截断至 400 字符"

- **F4.4 批更新标注**：禁用"实时"字样（R3）
  - 顶部标注："数据来自 x 分钟前的一批同步"
  - 使用 `ago(lastSyncAt)` 计算相对时间
  - 全站文案扫描无"实时"（R3 合规）

### 1.4 WebSocket 推送通道完善（F17.5-F17.6）

**文件**：`web/console/src/live.ts`

- **F17.5 重连补全量**：指数退避 1→30s 封顶 + 抖动
  - `computeReconnectDelay()`：`delay = min(base * 2^attempts, cap) + random(0, base)`
  - 默认 `base=1000ms`、`cap=30000ms`
  - 超过 5 次重连失败后降级到轮询
  - 重连成功后先 REST 全量（`fetchFullSnapshot()`）再收增量
  - `wasConnected` 标记区分首次连接与重连

- **F17.6 后台标签页停推**：`visibilitychange=hidden` 主动关连接
  - `handleVisibilityChange()` 监听 `document.hidden`
  - 进入后台：关闭 WS、停止轮询、清除重连定时器
  - 回到前台：重新调用 `connectWebSocket()`
  - 组件卸载时移除监听器

---

## 2. 测试覆盖

### 2.1 单元测试

**未新增前端单测**：M3 主要是 UI 增强，现有 Function 测试覆盖后端逻辑。

### 2.2 集成测试

**未新增集成测试**：需要在真实部署环境中验证。

### 2.3 手动验证清单

- [ ] 项目详情页显示运行历史列表（多条 run）
- [ ] 阻塞原因卡正确渲染（基础设施 vs 等待确认）
- [ ] 阶段流水线显示 14 阶段 + 门槛说明
- [ ] 时间线过滤器工作正常（阶段/类型/级别）
- [ ] 批更新标注显示"数据来自 x 分钟前"
- [ ] WebSocket 重连退避正确（1s → 2s → 4s → ... → 30s）
- [ ] 后台标签页关闭连接，回前台重连

---

## 3. 已知限制

1. **`block_detail` 字段未实现**：当前前端从 `block_reason` + `status` 推导，后端未新增字段
2. **`actor_role` 过滤未实现**：引擎侧未投影该字段，前端留接口但未使用
3. **重连后全量获取未验证**：`fetchFullSnapshot()` 逻辑已实现，但未在真实环境中测试
4. **后台标签页停推未验证**：`visibilitychange` 监听已实现，但未在真实浏览器中测试

---

## 4. 安全与合规

- **R3 合规**：全站文案无"实时"字样
- **F2.4 合规**：额度耗尽与科学失败视觉分离
- **NFR-12 合规**：14 阶段名严格对齐 WORKFLOW_SPEC.md
- **L2 降级合规**：敏感字段在公开级不显示

---

## 5. 下一步

M3 完成后，进入 M4：可见性 + 落地页 + 文档站 + 演示数据 + 移动适配。

M4 出口门禁：
- 48 项裁剪清单全绿
- 开放公开访问
- F5.1-F5.4, F5.6, F5.9（可见性）
- F6.1-F6.5（落地页 + 文档站）
- F7.1, F7.2, F7.4（演示数据）
- F15.1-F15.3（移动适配）
