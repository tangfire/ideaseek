# Web 控制台 Schema 漂移演练

**日期**: 2026-11-23
**目的**: 记录 `cloud_*` 表结构演进时的漂移检测与迁移策略，确保本地引擎与云端投影始终保持契约一致。

---

## 1. 契约层级

IdeaSeek 的云端投影涉及三层契约，任何一层变化都可能引发漂移：

| 层级 | 文件 | 变化频率 | 漂移检测 |
|------|------|----------|----------|
| **投影契约** | `cloud-projection-v1.json` | 低（主版本变更需协商） | `tests/function-contract-parity.test.ts` 钉住 Function 白名单与 JSON Schema 一致 |
| **数据库 Schema** | `web/migrations/0001_*.sql` + `0002_*.sql` | 中（新增表/列需迁移） | 受管迁移 `create_database_migration` 提交，`apply_database_migration` 执行 |
| **引擎侧实体** | `src/core/types.ts` + `src/cloud/projector.ts` | 高（每个功能模块可能新增字段） | `projector.ts` 的 `projectRun()` 等函数逐字段映射 |

---

## 2. 漂移场景与应对

### 2.1 引擎新增字段（向后兼容）

**场景**: 引擎在 `RunStatus` 枚举中新增 `PAUSED_FOR_REVIEW` 值。

**漂移检测**:
- `projector.ts` 的 `projectRun()` 直接透传 `status` 字段，无需修改；
- 前端 `STATUS_STATE` 映射表未登记新值 → 渲染为 `idle` 态（安全降级）；
- 控制台 `STAGES` 数组不受影响（阶段与状态是两套枚举）。

**应对**:
1. 前端 `app.tsx` 的 `STATUS_STATE` 补充 `PAUSED_FOR_REVIEW: 'blocked'`；
2. 测试用例覆盖新状态的渲染；
3. 无需数据库迁移或契约变更。

### 2.2 引擎新增实体（需投影）

**场景**: 引擎新增 `BenchmarkResult` 实体，需要在控制台展示。

**漂移检测**:
- `contract.ts` 的 `KNOWN_COLLECTIONS` 未登记 `'benchmarks'` → ingest 返回 `未知实体集合` 错误；
- 或 `KNOWN_COLLECTIONS` 已登记但 `ingest.ts` 的 `IMPLEMENTED` 未包含 → ingest 返回 `501 not implemented`。

**应对**:
1. `contract.ts` 的 `KNOWN_COLLECTIONS` 新增 `'benchmarks'`；
2. `web/migrations/0003_benchmarks.sql` 新建 `cloud_benchmark_result` 表；
3. `ingest.ts` 新增 `writeBenchmarks()` 函数，加入 `IMPLEMENTED`；
4. `views.ts` 新增 `benchmarkView()` 读路径；
5. `routes.ts` 新增 `/views/benchmarks` 路由；
6. `types.ts` 新增 `BenchmarkResult` 类型；
7. `app.tsx` 新增 `BenchmarkList` 组件；
8. 测试覆盖全链路。

### 2.3 数据库列类型变更（破坏性）

**场景**: `cloud_cost_entry.usd_micro` 从 `bigint` 改为 `numeric(12, 6)` 以支持小数微美元。

**漂移检测**:
- 受管迁移 `create_database_migration` 提交 `ALTER TABLE` 语句；
- 若受管子集不支持 `numeric` 类型（SPIKE_SITES_RUNTIME.md §2），迁移被拒绝；
- 需改用 `text` 列 + Function 侧解析，或保持 `bigint` 用更小单位（如 0.1 微美元）。

**应对**:
1. 评估受管子集支持情况；
2. 若不支持，改用 `bigint` 存储 0.1 微美元（`usd_deci_micro`），Function 侧除以 10；
3. 前端 `CostDashboard` 显示逻辑相应调整；
4. 无需契约变更（`cloud-projection-v1.json` 只约束形状不约束精度）。

### 2.4 契约主版本升级（协商性）

**场景**: `cloud-projection-v1.json` 升级为 v2，新增必填字段 `entities.benchmarks`。

**漂移检测**:
- `contract.ts` 的 `SUPPORTED_SCHEMA_MAJOR` 仍为 `1` → 收到 v2 批次返回 `415 Unsupported Media Type`；
- 本地引擎 `projector.ts` 生成 v1 批次 → 云端 Function 拒绝。

**应对**:
1. 协商升级时间表：本地引擎与云端 Function 必须同步更新；
2. `contract.ts` 的 `SUPPORTED_SCHEMA_MAJOR` 改为 `2`；
3. `KNOWN_COLLECTIONS` 新增 `'benchmarks'`；
4. `ingest.ts` 新增 `writeBenchmarks()`；
5. 测试覆盖 v1→v2 迁移（旧批次仍能解析，新批次必须带 benchmarks）。

---

## 3. 漂移演练清单

定期执行以下检查，确保契约三层一致：

- [ ] `pnpm test:function` 全绿（`function-contract-parity` 测试钉住白名单）；
- [ ] `web/console` 的 `tsc --noEmit` 零错误（类型定义与 API 响应一致）；
- [ ] `cloud-projection-v1.json` 的 `entities` 键集合 ⊇ `contract.ts` 的 `KNOWN_COLLECTIONS`；
- [ ] `ingest.ts` 的 `IMPLEMENTED` ⊆ `KNOWN_COLLECTIONS`（未实现的集合显式 501 拒绝）；
- [ ] `views.ts` 的读路径覆盖所有 `cloud_*` 表（除 `live_outbox` 等内部表）；
- [ ] `app.tsx` 的组件覆盖所有 `views.ts` 暴露的数据（L1 字段在 L2 降级时显式标注）；
- [ ] 文案无"实时"字样（`grep -r "实时" web/console/src/` 零命中）；
- [ ] sync_token 只存哈希（`grep -r "plain_token\|token_hash" web/functions/` 确认入库路径）。

---

## 4. 当前已知漂移

| 漂移项 | 位置 | 状态 | 应对 |
|--------|------|------|------|
| `gpu_seconds` 列缺失 | `cloud_cost_entry` 表 vs ER 图 | 接受 | 受管子集不支持 `bigint` 以外的数值类型，GPU 秒暂不投影；若需展示，改用 `tokens_in` 字段暂存或新增 `text` 列 |
| `block_detail` 未实现 | 前端类型 vs 后端 API | 已知 | 前端从 `block_reason` + `status` 推导，后端未返回此字段；待引擎投影 `BlockDetail` 结构后补全 |
| 深视图表未查询 | `views.ts` `projectView()` vs M5 组件 | 已知 | `ideas`/`papers`/`claims`/`experiments`/`protocols` 字段在 `ProjectView` 类型中声明，但 `projectView()` 未查询对应表；待后端补全查询逻辑 |
| 引擎侧 egress 未实现 | `PRODUCT_GAPS_AUDIT.md` 缺口 12 | 阻塞 | F13 外发台账功能已就绪，但引擎不产生数据；台账显示"引擎尚未产生外发计数数据" |

---

## 5. 迁移脚本规范

新增 `cloud_*` 表时，遵循以下规范：

1. **文件命名**: `web/migrations/NNNN_description.sql`（NNNN 为四位序号）；
2. **语句限制**: 单个迁移文件不超过 20 条 SQL 语句（受管子集上限）；
3. **类型限制**: 只使用 `boolean`/`integer`/`bigint`/`text`/`uuid`/`timestamptz`/`jsonb`；
4. **约束限制**: 只使用 `NULL`/`NOT NULL`/`PRIMARY KEY`/`UNIQUE`/`REFERENCES`（app 内）；不支持 `CHECK`/`identity`/`serial`/`generated`；
5. **索引限制**: 只支持普通列名索引；不支持 `DESC`/`WHERE`（部分索引）/表达式索引；
6. **注释**: 提交前去掉 SQL 注释（受管子集未声明支持）；
7. **幂等**: 不使用 `IF NOT EXISTS`（受管子集不支持）；迁移失败时手动清理后重跑。

---

## 6. 参考

- `docs/web-console/SPIKE_SITES_RUNTIME.md` §2: 受管迁移子集限制
- `docs/web-console/REQUIREMENTS.md` §3.2: 投影契约与版本协商
- `docs/web-console/PLAN.md` §3: 前置 Spike 结论
- `web/functions/contract.ts`: 入口校验与白名单
- `web/functions/ingest.ts`: 写入路径与幂等 upsert
- `web/functions/views.ts`: 读路径与可见性判定
