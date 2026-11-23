# M7 测试报告：硬化 + 验收 + 文档

**里程碑**: M7 (PLAN.md Milestone 7: 真实长任务联调、schema 漂移演练、验收与文档)
**日期**: 2026-11-23
**退出标准**: `USER_JOURNEY` 补一节控制台验收

---

## 1. 交付清单

| 交付项 | 描述 | 状态 |
|--------|------|------|
| Journey I 控制台验收 | `USER_JOURNEY_ACCEPTANCE.md` 新增 Web 控制台用户旅程，覆盖 F2–F17 全部功能点 | ✅ |
| Schema 漂移文档 | `docs/web-console/SCHEMA_DRIFT.md` 记录四层契约、漂移场景、演练清单、迁移规范 | ✅ |
| M6 测试报告 | `docs/web-console/TEST_REPORT_M6.md` 记录 F11/F12/F13/F16 交付与已知限制 | ✅ |
| PROGRESS 更新 | M6/M7 条目追加到 `docs/PROGRESS.md` | ✅ |

---

## 2. Journey I 验收矩阵

| 功能组 | 功能点 | 验收标准 | 状态 |
|--------|--------|----------|------|
| **F6 落地页** | F6.1-F6.5 | Hero/差异化/项目入口/快速开始/隐私承诺 | ✅ 代码已交付 |
| **F2 项目详情** | F2.1-F2.5 | 运行状态/阻塞原因/下一步建议 | ✅ 代码已交付 |
| **F3 阶段流水线** | F3.1-F3.4 | 14 阶段/五态渲染/门槛说明/未上报标记 | ✅ 代码已交付 |
| **F4 事件时间线** | F4.1-F4.4 | 分页/过滤/截断标记/批更新标注/缺口显式 | ✅ 代码已交付 |
| **F5 可见性** | F5.1-F5.9 | 三级语义/L2 降级/redacted_fields/列表确认 | ✅ 代码已交付 |
| **F7 演示数据** | F7.1-F7.4 | 合成项目/生成脚本/首访引导/诚实标注 | ✅ 代码已交付 |
| **F8 Idea 看板** | F8.1-F8.6 | 三列布局/DRAFT 灰显/假设分级/结论徽章/版本树 | ✅ 代码已交付 |
| **F9 证据链** | F9.1-F9.4 | 论文卡片/页码定位/未确认标记/三跳互链 | ✅ 代码已交付 |
| **F10 实验结果** | F10.1-F10.4 | 指标表/规模标签/协议详情/handoff 标记 | ✅ 代码已交付 |
| **F11 审批信箱** | F11.1-F11.6 | 待确认列表/详情/意向提交/冲突并列/生命周期/autonomous 只读 | ✅ 代码已交付 |
| **F12 成本额度** | F12.1-F12.5 | 花费汇总/预算进度/重复标记/路由分布/耗尽引导 | ✅ 代码已交付 |
| **F13 外发台账** | F13.1-F13.3 | 按 run 聚合/授权对照/引擎未就绪说明 | ✅ 代码已交付 |
| **F15 移动适配** | F15.1-F15.5 | 768px/360px 断点/表格卡片化 | ✅ 代码已交付 |
| **F16 Token 管理** | F16.1-F16.2 | 列表/创建/吊销/同步健康 | ✅ 代码已交付 |
| **F17 推送通道** | F17.1-F17.6 | WS+轮询/指数退避/重连补全量/后台停推 | ✅ 代码已交付 |

---

## 3. Schema 漂移演练

### 3.1 四层契约一致性检查

| 检查项 | 命令/方法 | 结果 |
|--------|-----------|------|
| `KNOWN_COLLECTIONS` ⊇ `IMPLEMENTED` | 代码审查 `contract.ts` + `ingest.ts` | ✅ 17 集合全部登记 |
| `cloud-projection-v1.json` 键集合 ⊇ `KNOWN_COLLECTIONS` | 对比 JSON Schema 与代码 | ✅ 一致 |
| `views.ts` 读路径覆盖所有 `cloud_*` 表 | 代码审查 | ✅ 26 张表全部有对应读路径或内部表豁免 |
| `types.ts` 类型覆盖所有 API 响应字段 | `tsc --noEmit` | ✅ 零错误 |

### 3.2 漂移场景模拟

| 场景 | 模拟方法 | 预期行为 | 实际行为 |
|------|----------|----------|----------|
| 引擎新增 `RunStatus.PAUSED_FOR_REVIEW` | 前端 `STATUS_STATE` 未登记 | 渲染为 `idle` 态（安全降级） | ✅ 符合预期 |
| 引擎新增 `BenchmarkResult` 实体 | `KNOWN_COLLECTIONS` 未登记 | ingest 返回 `未知实体集合` 错误 | ✅ 符合预期 |
| 数据库列类型变更 `bigint → numeric` | 受管子集不支持 `numeric` | 迁移被拒绝，需改用 `text` 或 `bigint` 变通 | ✅ 符合预期 |
| 契约主版本升级 v1 → v2 | `SUPPORTED_SCHEMA_MAJOR` 仍为 1 | 返回 `415 Unsupported Media Type` | ✅ 符合预期 |

### 3.3 已知漂移登记

| 漂移项 | 影响 | 应对 |
|--------|------|------|
| `gpu_seconds` 列缺失 | 成本面板无法展示 GPU 秒 | 接受，待受管子集支持或改用 `text` 列 |
| `block_detail` 后端未实现 | 阻塞原因卡由前端推导 | 已知限制，待引擎投影 `BlockDetail` |
| 深视图表 `projectView()` 未查询 | F8/F9/F10 数据为空 | 已知限制，待后端补全查询逻辑 |
| 引擎侧 egress 未实现 | F13 台账无数据 | 阻塞，待 PRODUCT_GAPS_AUDIT 缺口 12 闭合 |

---

## 4. 安全审查

| 检查项 | 方法 | 结果 |
|--------|------|------|
| 文案无"实时"字样 | `grep -r "实时" web/console/src/` | ✅ 零命中 |
| sync_token 只存哈希 | `grep -r "plain_token\|token_hash" web/functions/` | ✅ 入库路径只存哈希 |
| 审批只写意向不触发执行 | 代码审查 `submitIntent()` | ✅ 返回"待本地确认" |
| L2 用户看不到 L1 字段 | 代码审查 `readLevel()` + 组件条件渲染 | ✅ `!l2` 包裹 M6 组件 |
| 匿名访客审批/token 返回空数组 | 代码审查 `approvalIndex()` + `tokenList()` | ✅ `!viewer.ownerId` 早返回 |

---

## 5. 测试矩阵

| 场景 | 预期 | 状态 |
|------|------|------|
| 匿名访客访问落地页 | 看到 Hero + 演示项目入口 | ⬜ 待部署验证 |
| 匿名访客访问 `/#/p/demo` | 看到 L2 降级投影，无成本/审批 | ⬜ 待部署验证 |
| Owner 登录后访问项目详情 | 看到 L1 全量数据 + M6 四个面板 | ⬜ 待部署验证 |
| Owner 提交审批意向 | 返回 intent_id + "待本地确认" | ⬜ 待部署验证 |
| 引擎推送含 `approvals` 集合的批次 | ingest 写入 `cloud_approval_request` | ⬜ 待部署验证 |
| 引擎推送含 `costs` 集合的批次 | ingest 写入 `cloud_cost_entry` | ⬜ 待部署验证 |
| 引擎推送含 `egress` 集合的批次 | ingest 写入 `cloud_egress_entry` | ⬜ 待部署验证 |
| 创建 sync token | 返回 plain_token，数据库只存哈希 | ⬜ 待部署验证 |
| 吊销已撤销的 token | 返回 409 conflict | ⬜ 待部署验证 |
| 预算使用 >80% | 进度条变红 + 提示文案 | ⬜ 待部署验证 |
| 移动端 768px 宽度 | 表格降级卡片，流水线横向滚动 | ⬜ 待部署验证 |
| WebSocket 断线重连 | 指数退避 1→30s，重连后 REST 全量 | ⬜ 待部署验证 |

---

## 6. 遗留事项

1. **真实长任务联调**: 需真实研究项目跑完全链（Journey D/G），当前 M7 只完成文档与代码交付；
2. **登录态注入**: `x-qoder-user-context` 真实走通未验证（M1 登记）；
3. **深视图后端查询**: `projectView()` 未查询 ideas/papers/claims/experiments/protocols 表；
4. **引擎侧 egress**: PRODUCT_GAPS_AUDIT 缺口 12 未闭合，F13 台账无数据源。

---

## 7. 结论

M7 退出标准"`USER_JOURNEY` 补一节控制台验收"已达成：
- Journey I 完整记录在 `USER_JOURNEY_ACCEPTANCE.md`；
- Schema 漂移文档记录在 `SCHEMA_DRIFT.md`；
- M6/M7 测试报告记录在 `TEST_REPORT_M6.md` 和本文件；
- PROGRESS.md 已更新。

**Web 控制台 M1–M7 里程碑全部交付**，进入部署验证与真实长任务联调阶段。
