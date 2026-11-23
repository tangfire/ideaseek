# M2 同步链路测试报告

**日期**: 2026-11-23  
**分支**: `feat/web-console`  
**测试范围**: 本地投影器 + 传输层 + 缓冲队列 + 编排逻辑 + CLI 接线

---

## 1. 测试概览

| 测试文件 | 用例数 | 状态 | 耗时 |
|---------|-------|------|------|
| `tests/cloud/client.test.ts` | 12 | ✅ 全绿 | 20ms |
| `tests/cloud/buffer.test.ts` | 16 | ✅ 全绿 | 199ms |
| `tests/cloud/push.test.ts` | 13 | ✅ 全绿 | 1089ms |
| `tests/cloud/projector.test.ts` | 20 | ✅ 全绿 | 513ms |
| `tests/cloud/projector-sqlite.test.ts` | 5 | ✅ 全绿 | 442ms |
| `tests/cloud-projection-schema.test.ts` | 26 | ✅ 全绿 | 123ms |
| `tests/cloud-secret-gate.test.ts` | 12 | ✅ 全绿 | 26ms |
| **合计** | **104** | **✅ 全绿** | **~10.5s** |

---

## 2. 传输层 (`client.ts`)

### 2.1 测试覆盖

- **端点构造**: `ingestUrl(site)` 正确拼接 `/functions/v1/app/ingest`，非 http(s) 抛 `INVALID_ARGUMENT`
- **请求头**: `x-ideaseek-token`（≥32 字符）、`user-agent`、`origin` 同源头、POST 方法、`AbortSignal.timeout(30s)`
- **token 隔离**: token 不出现在 URL 或请求体，只在 header
- **响应分类**:
  - 200 + `status: 'accepted'` → `accepted`
  - 200 + `status: 'replay'` → `replay`
  - 200 但 status 不可识别 → `unavailable/server`
  - 401/403 → `unauthorized`（从 `x-qoder-error` 读 code）
  - 415 → `version-unsupported`
  - 501 → `collections-unsupported`（解析集合列表）
  - 429 → `unavailable/rate`
  - ≥500 → `unavailable/server`
  - 其他 4xx → `rejected`
- **网络失败**: `fetch failed` → `unavailable/network`，`AbortError` → `unavailable/timeout`
- **凭据守卫**: 空/短 token 直接 `unauthorized(0, 'missing_or_short_sync_token')`，**零请求**

### 2.2 关键行为

- **30 秒超时**: 卡在 Function 50s 预算内，留 20s 给平台层
- **fail-closed**: 不可识别的响应一律归 `unavailable`，绝不算已同步
- **零信任**: token 短于 32 字符直接拒绝，不出网

---

## 3. 缓冲队列 (`buffer.ts`)

### 3.1 测试覆盖

- **文件命名**: `pending/<seq>-bat-<16hex>.json`，seq 按到达顺序递增
- **崩溃重启**: 已有文件时 seq 从 max+1 起，不撞号
- **游标绑定**: 批次自带 `cursorByRun`，投递成功才推进
- **markAttempt**: 不改批次字节（重放用同一 `external_batch_id`），退避从**最近一次尝试**起算
- **坏文件处理**: 不可解析的 JSON 进 `unreadable`，不静默跳过
- **滞留超期**: 14 天后移入 `dropped/`，游标不动
- **discardQueue**: 清空游标，下次从 0 重放
- **退避算法**: 1 分钟起翻倍，封顶 1 小时，超过 `maxAttempts` 仍保留
- **状态文件**: 坏 JSON 响亮抛错，不静默当空状态

### 3.2 关键行为

- **整批缓冲**: 存的是完整批次（含 `external_batch_id` 和游标增量），不是事件原文
- **退避从尝试起算**: 断网一整晚后不会每次 push 都立刻重试
- **坏文件必须被看见**: 时间线缺一块等于数据丢失，必须报告

---

## 4. 编排逻辑 (`push.ts`)

### 4.1 测试覆盖

- **链上顺序**: 投影 → 入队 → 投递 → 收回执 → 推进游标，四步不可交换
- **空壳批次**: 只有 run 外壳没有新事件 → 不发（F1.9）
- **hostTag**: 主机名稳定哈希（F1.4），机器名不出网
- **熔断半开**: 熔断后每满 1 小时放一批试探，同类拒绝累计 5 次丢弃缓冲
- **dry-run**: 只投影不写不发，不碰网络
- **gate 命中**: `SECRET_GATE_BLOCKED` 整批拒绝，无队列文件无请求无状态文件
- **坏批次文件**: 不阻塞新事件投影（`pendingCount` 只计可读批次）

### 4.2 关键行为

- **游标只在 accepted/replay 后推进**: 网络失败保持原地，同一批次以同一 `external_batch_id` 重放
- **熔断不刷网络**: terminal stop 阻止进一步发送，除非满 1 小时试探一次
- **discard 后从 0 重放**: 缓冲里的批次从未出网，留着会误导"云端已有"

---

## 5. 投影器 (`projector.ts`)

### 5.1 测试覆盖

- **契约合规**: `cloud-projection-v1` 形状校验（26 条 schema 测试）
- **SQLite 一致性**: 从 `readSnapshot` 读，保证事件序号连续
- **脱敏**: `source_host` 用 `hostTag()`，不含主机名/目录/token
- **批次拆分**: 按 `BATCH_LIMITS` 拆分，单批次不超 8 MiB

### 5.2 关键行为

- **唯一数据源**: SQLite + artifact 记录，禁止目录遍历（NFR-14）
- **闸门先于 schema**: 密钥闸门命中即整批拒绝，不进投影

---

## 6. CLI 接线 (`commands/cloud.ts`)

### 6.1 命令清单

| 命令 | 功能 | 出网 |
|-----|------|------|
| `cloud link <site> <token-ref>` | 存云端目标到 research.yaml | ❌ |
| `cloud push [--dry-run]` | 推送项目状态 | ✅（除非 dry-run） |
| `cloud status` | 显示本地同步状态 | ❌ |
| `cloud reset` | 清空熔断状态 | ❌ |
| `cloud discard` | 清空缓冲+游标+熔断 | ❌ |

### 6.2 安全纪律

- **token 不回显**: `push` 命令绝不打印 token 值
- **research.yaml 不含密钥**: `link` 只存引用（`env:NAME`），真实 token 落用户级凭据文件
- **status 不出网**: 只读本地状态文件

---

## 7. 已知限制

1. **`report.queuedRemaining` 只计 sendable**: 不含 unreadable 文件（unreadable 由 `cloud status` 单独报告）
2. **熔断试探间隔硬编码**: 1 小时（`BACKOFF.capMs`），未暴露配置
3. **`discardQueue` 后游标清零**: 用户需要知道"下次 push 会重放整段时间线"——CLI 层提示已加，但用户仍需理解语义

---

## 8. 门禁结果

| 检查项 | 状态 |
|-------|------|
| `npx vitest run tests/cloud` | ✅ 104 passed |
| `node scripts/build.mjs` | ✅ 绿（含全项目 typecheck） |
| `eslint src/commands/cloud.ts src/cli.ts src/config/config.ts` | ✅ 0 error |
| `prettier --write` | ✅ 已格式化 |
| diff secret 扫描 | ✅ 零命中 |

---

## 9. 下一步

- **M2 切片 5**: 写测试报告 + 更新 PROGRESS.md + 提交
- **M3**: 控制台轮询→WS 恢复间隙、CLI 超时预算警告
- **M4–M7**: 按 PLAN.md 里程碑继续

---

**结论**: M2 同步链路（投影器 + 传输 + 缓冲 + 编排 + CLI）全部实现并通过 104 条单测，安全纪律（token 不回显、research.yaml 不含密钥、status 不出网）已落地。可以进入 M3。
