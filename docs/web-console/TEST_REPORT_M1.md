# M1 测试报告 — Spike S1–S6 + 工程骨架 + `cloud_*` 建表 + 投影契约

- 日期：2026-11-22（读数时间戳均为 UTC）
- 分支：`feat/web-console`（基线 `origin/main@8856c42`）
- 里程碑出口门禁（`PLAN.md` §4）：**spike 报告** + **主线 `pnpm test` 仍全绿**
- 判定：**通过（附条件）**——条件见 §6"未验证清单"，全部登记在 `SPIKE_SITES_RUNTIME.md` §10.9，不在本报告里被"通过"二字盖掉。

---

## 1. 交付物清单（这一里程碑真正产出了什么）

| 类别 | 交付物 | 由什么证明 |
| --- | --- | --- |
| Spike 报告 | `docs/web-console/SPIKE_SITES_RUNTIME.md` §0–§10 | §10 是部署实测读数，不是推定 |
| 工程骨架 | `web/console/`（React + Vite，独立安装，hash 路由） | 已发布到正式站并在浏览器读回深链（§4.4） |
| Function | `web/functions/`（`index.ts` + 9 个模块 + 本地入口 + 内存适配器） | Node lane 21/21 + 部署态实测 |
| 建表 | 26 张 `cloud_*` 表（`web/migrations/0001–0002`）经**受管迁移**建成 | `get_database_schema` 列出 26 表；`/probe/db` 读到行数 |
| 投影契约 | `src/core/schema/schemas/cloud-projection-v1.json` + 注册表登记 | `tests/cloud-projection-schema.test.ts`、`tests/function-contract-parity.test.ts` |
| 跨语言一致性 | Function 侧手写白名单与主线 schema 的 parity 测试 | 同上（漂移即红） |

**没有产出的**（避免把文档当交付）：`cloud push` 命令本体（M2）、脱敏与密钥闸门（M2）、核心观测 UI（M3）、公开演示与落地页（M4）。

---

## 2. 门禁执行记录

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 格式 | `pnpm format:check` | **本机不可判定**，改以入库字节评估：558 个受检文件中 8 个未格式化，全部是**未改动的历史文件**（`scripts/aris-vendor.mjs`、`src/commands/{assessment,doctor}.ts`、`analysis-verdict-v1.json`、`capability-guard.ts`、`tests/{guidance-language,paper-place-figures,paper-results-export}.test.ts`）。本轮**新写与改动**的文件全部格式化通过。原因见 §5 |
| Lint | `pnpm lint` | 通过（0 error） |
| 类型 | `pnpm typecheck` | 通过 |
| 控制台子工程 | `web/console`：`pnpm typecheck` + `pnpm build` | 通过（`tsc --noEmit`；构建产物 `index-Cim3_YfU.js` 231.9 kB / gzip 74.2 kB） |
| Function 本地 lane | `pnpm test:function` | **21/21 通过**（`routes.test.ts` 15 + `identity.test.ts` 6） |
| 发布卫生闸门 | `node scripts/release-check.mjs` | `ok:true`、`secrets:0`（本轮先红过一次：测试 fixture 撞高熵凭据规则，见 §5"全量门禁报出一条 `secrets: 1`"那一行） |
| 主线全量 | `pnpm test`（vitest + interactive lane + python） | 见 §3 |

### 3. 主线全量结果

`pnpm test` = vitest 全量 + interactive lane + python 车道。本轮跑了四次全量：前三次**都不是干净的绿灯**，第四次才拿到出口要求的读数；四次都登记在这里，不拿最后一次盖掉前面。

| 次序 | 读数 | 失败项 |
| --- | --- | --- |
| 第 1 次 | `Test Files 3 failed / 212 passed (215)`，`Tests 3 failed / 1963 passed / 4 skipped (1970)`，`Duration 809.51s`，EXIT=1 | `consolidate`（`expected 2 to be +0`）、`idea-check`（CLI 超时）、`pack`（`--verify-reproducible` 180 s 超时） |
| 第 2 次 | `Test Files 2 failed / 213 passed (215)`，`Tests 2 failed / 1964 passed / 4 skipped (1970)`，`Duration 756.73s`，EXIT=1 | `idea-check`（CLI 超时）、**`release-check`（真缺陷：本轮新增的测试 fixture 撞高熵凭据闸门，见 §5 第 8 行）** |
| 第 3 次（修正凭据 fixture 之后） | `Test Files 1 failed / 214 passed (215)`，`Tests 1 failed / 1965 passed / 4 skipped (1970)`，`Duration 709.94s`，EXIT=1 | 仅 `idea-check > classifies a dependency failure in the unit-test phase`：`cli idea check calib-reweight --json timed out` |
| 第 4 次（放宽 CLI 派生用例的墙上时间预算之后，`44bb4b5`） | **`Test Files 215 passed (215)`，`Tests 1966 passed / 4 skipped (1970)`，`Duration 472.09s`**；interactive lane `3 passed / 26 tests`；python 车道 `Ran 23 tests ... OK`；EXIT=0 | 无 |

对唯一剩下的那一条做的取证（不是"重跑直到绿"）：

- 单独串行跑同一文件：`Test Files 1 passed (1) / Tests 16 passed (16) / Duration 70.28s`，EXIT=0；该文件 `tests` 净耗时 61.03 s，用例级超时预算在满载并行下会被吃穿。
- 第 1 次的 `consolidate`、`pack` 也在 `--maxWorkers=1` 下与 `idea-check` 一起 27/27 通过（`Duration 142.46s`）。
- 同类先例已有登记口径：`docs/PROGRESS.md:338` 把 CLI 派生用例在全并行下的超时归为**环境性非回归**。

**判定口径**：M1 出口要求"主线 `pnpm test` 仍全绿"。前三次没有一次是绿的，第四次（`44bb4b5` 之后）拿到 `215/215 files、1966 passed / 4 skipped、EXIT=0`，出口条件按这个读数成立。前三次的红不是环境问题掩盖过去的：第 2 次的 `release-check` 是本轮真实缺陷（§5 第 8 行），第 1、3 次的 CLI 超时按 §3 的取证把预算改成按满载实测推导的值——**只放宽时间预算，断言与阈值一个没改**，这一点如果做不到就不该改。

---

## 4. 部署实测（M1 出口的核心证据）

原始读数与脚本行为记录在 `SPIKE_SITES_RUNTIME.md` §10；这里只列"验收项 → 读数"的对应关系。**所有数值都在真实部署站上量到，不在内存适配器里模拟**。

### 4.1 平台能力（S1/S2/S4/S6）

| 项 | 读数 | 判定 |
| --- | --- | --- |
| 运行时 | `supabase-edge-runtime`（兼容 Deno v1.45.2）、V8 11.6.189.12、TS 5.1.6 | S1 通过 |
| 能力面 | `fetch` / `crypto.subtle` / `crypto.randomUUID` / `Deno.upgradeWebSocket` / `Deno.env`（含 `get`）全可用 | S1 通过 |
| 执行超时 | 50 s 通过（`elapsed_ms` 50 001）；60 s → `504 upstream request timeout` | 预算 ∈ (50 s, 60 s] |
| 请求体上限 | 1/4/8 MiB 精确收到；16 MiB **连接级失败无状态码**；32 MiB → `413` | 安全上限取 8 MiB |
| 连库与建表 | 26 张 `cloud_*` 表建成，Function 读写均通 | S2 通过 |
| WS 握手 | 101 可达，173–276 ms 打开；echo RTT 65 ms；5 条并发全通 | S6 通过 |
| WS 边界 | 5 000 字节帧 → `close 1009 message_too_large`；空闲 → 55 232 ms `close 1000 lifetime` | 4 KiB 闸生效；寿命 55 s |
| **服务端主动推** | 已连接的 `/live` WS 上，ingest 之后 **1 354 ms** 收到 `{"type":"state","seq":2}`，期间客户端**不发任何请求** | S6 通过标准中最硬的一条 |

### 4.2 同步链与幂等（F1.8）

| 步骤 | 读数 |
| --- | --- |
| 首轮 ingest | `200 accepted`，`counts {runs:1,stages:1,events:1}` |
| 同一 `external_batch_id` 重放 | `200 {"status":"replay"}`，不二次写入 |
| 未实装集合 | `501 …projection_collections_not_implemented`（收下再丢掉是不可接受的降级） |
| 未知主版本 | `415 invalid_projection`（整批拒绝） |
| 缺 `Origin` 的 POST | `403 sites_gateway_origin_forbidden`（网关 CSRF 闸门，M2 投影器必须带） |
| 空 `User-Agent` | `403 BOT_DETECTED`（边缘反机器人层；`ws` 客户端默认不发 UA，必须显式加） |

### 4.3 可见性与脱敏（F5.1/F5.2/F5.6/Q1）

| 场景 | 预期 | 实测 |
| --- | --- | --- |
| 匿名读 `private` 项目 | 不存在 | `404 not_found` |
| 匿名列表（无私开项目） | 空 | `projects: []` |
| 匿名读 `listed` 项目 | L2，且 L1 列**根本不进 SELECT** | `projection_level:"l2"` + 11 项 `redacted_fields`；正文无 `status`/`block_reason`/`spent_usd_micro`/`gate_note`/`strategy`/`autonomy`，`events: []` |
| 未记名 share token | 只降级不升级 | 本地 lane 覆盖（link 项目持链得 L2）；部署态同一路径未单独复测 |
| 撤销 share | 回到"不存在" | 本地 lane 覆盖 |
| 可见性从 `listed` 拨回 `private` | 旧深链立即读不到 | `/views/project` → 404、`/live` → 404、`/views/index` → `[]` |
| 身份相关响应缓存 | 不得被网关/浏览器缓存 | 全部响应带 `cache-control: private, no-store`；WS 的 101 原样透传（有专门用例守住"不许重新包一层"） |

### 4.4 端到端 spike 验收（PLAN §3 通过标准原文）

一条伪造投影 → 推到云端库 → 浏览器 hash 深链读到，且匿名角色读不到敏感列：

1. `POST /ingest`（合成批 `bat-000001a2029e947b`，项目 `spike-m1-demo`）→ `accepted`；
2. 浏览器打开 `https://ideaseek-t7xsgawx37d.qoder.zone/#/p/spike-m1-demo`（**不登录**）→ 渲染 L2 视图：标题、阶段链（15 个阶段 + 当前 `IDEA_GENERATION`）、同步时间"9 分钟前"、`strategy/autonomy` 显示"不在这一级"、传输位"服务端推送"、事件区文案"事件摘要不在公开降级投影（L2）这一级"；
3. 同一匿名身份的 API 读数与页面一致（§4.3）；
4. 把可见性拨回 `private` 后，同一 URL 的三条读全部 404 / 空。

**结论：S1–S6 全部通过，技术栈成立**，M2 可以按 WS + 事件驱动心跳的形状开工；`/live` 的 15 s 轮询分支已实现且实测可用，作为兜底保留。

---

## 5. 本轮过程中改掉的东西（不写下来就等于没发生）

| 症状 | 根因 | 处置 |
| --- | --- | --- |
| Function 启动即挂：`does not provide an export named 'getUser'` | 平台注入模块只导出 4 个名字，文档里的 `getUser/requireUser` 属于参照实现 | vendor `auth.mjs`（逐字节，sha256 记录在 §10.1），`identity.ts` 做映射，`index.ts` 只 import 真实导出 |
| 带正确 token 仍 `login_required` | 网关剥掉 `Authorization`（`/probe/ingress` 读数 `authorization=false`、`sync_header=true`） | 机器凭据改走 `x-ideaseek-token`，`Bearer` 保留给直连/本地；两条路各有一例测试 |
| WS 全部 403 | 边缘层拒绝空 `User-Agent`（`BOT_DETECTED`） | 脚本客户端显式带 UA；同时确认普通 HTTP 无 UA 也走得到 Function（不是同一道闸） |
| `/live` 升级请求拿到 `502`（正文空） | 缺 `?action=live` → 路由走轮询兜底 → 升级请求收到普通响应 | 读数与原因写入 §10.7；这条如果不当场查清，就会被写成"平台不支持 WebSocket" |
| `pnpm test` 首轮 128 例失败、`exit 9009` 无输出 | Windows Store 的 `python` 占位程序抢先命中 PATH | 门禁运行前把 `worker/python/.venv/Scripts` 置于 PATH 首位；`python --version` = 3.12.14 |
| 全量门禁报出一条 `secrets: 1` | `release-check` 的高熵凭据闸门命中 `web/functions/test/routes.test.ts` 里的 `DIAG_TOKEN = '<48 个 0>'`——形状确实像凭据 | 闸门不动：先试短占位串，被 `token.ts` 的 ≥32 下限打回 401/403（那条下限是"机器凭据不可猜"的防线，测试不该绕过），最后改成由 label 拼出 48 位不透明串。车道回到 21/21，`release-check` `ok:true`、`secrets:0`（`f16b8d7`） |
| `pnpm format:check` 报 550+ 文件 | 本机 `core.autocrlf=true`，工作树是 CRLF 而 `.prettierrc` 要 `endOfLine: lf`；**索引里是 LF**（`git ls-files --eol` = `i/lf w/crlf`） | 改以入库字节评估格式（等价于 CI 视图），并只格式化本轮新写/改动的文件；不去 `git config`、不产生 500+ 文件噪音 diff |
| 界面 L2 显示 `strategy=未记录`、传输位写"实时推送" | "扣下的字段"被读成"没记录"；"实时"撞 REQUIREMENTS §3.4 红线（R3） | 文案改为"不在这一级" / "服务端推送"；重新发布并在浏览器复检 |

---

## 6. 未验证清单（悲观评审，M2 入口条件）

1. **登录态注入未实测**：`x-qoder-user-context` 在真实登录浏览器下是否到达 Function、`full` 视图是否只对 Owner 生效——**只有合成上下文测试**。不代为登录、不索取凭据是红线，所以这条只能等到负责人自己在浏览器里登录一次再量（M2 安全验收 M-5 的一部分）。
2. **M-5 防绕过全未做**：Provider 直连、备用入口、跨租户隔离、vendored `auth.mjs` 的校验强度。
3. **写频与并发未量**（M-3 只量了单次请求体），批大小/心跳只能先按时间预算设计。
4. **WS 并发天花板未量**（只试到 5 条）、平台侧更早收线的可能性未排除。
5. **`user_id → cloud_owner.email` 首次登录自动建行**是本轮的**决定**而非平台保证：站内任何已登录账号都会获得一个 Owner 主体（只能看见自己投影上来的数据）。M4 公开上线检查单要重看这一条。
6. **Function 侧契约校验是手写白名单**，ajv standalone 生成器仍未做；M2 放开 17 个集合之前必须换成构建期生成并入 `release-check`，否则会出现"看起来严、实际漏"。
7. `is_synthetic` / 合成演示数据**没有被当作真实结论**：本轮所有云端行都是合成投影，`spike-m1-demo` 已拨回 `private`。
8. **CLI 派生用例的超时预算**：已按满载实测改掉（`44bb4b5`，§3 第 4 次读数绿）。留一条警告：这种预算是**这台机器这次的负载**量出来的，换并发度或换机器可能要重看；正确的长期解是给这些用例一个按负载推导的预算或把它们归到单独的串行 lane。
9. **前端降级到轮询后不会回 WS**：`web/console/src/live.ts` 一次性 WS 失败后永久停在轮询，没有探测式回升。当前读数如实显示"降级：15 s 轮询"，不构成谎报，但 NFR-16 在恢复后仍按轮询评估——列入 M3。

---

## 7. 环境与可复现性

- Node v24.11.1（`D:/tools/node-v24.11.1-win-x64`，不在默认 PATH）、pnpm 12.21、vitest 4.1.12、python 3.12.14（`worker/python/.venv`）。
- 部署态脚本放在 **git-ignored** 的 `.local/`（含一次性探针 token 文件，绝不入库、绝不回显值）。
- 站点：`ideaseek-t7xsgawx37d.qoder.zone`，projectId `01a20236-0bb5-70d0-8725-85eb306c8203`，siteId `01a20236-0bb8-7b28-97ba-6d14e9abbfad`；本轮两次发布 actionId `4d7e2a18-…`（Function 修复）与 `0db688ef-…`（文案 + 注释修正，publish operation `01a202a7-89aa-72c3-85b4-d7c05f83036c`，state `succeeded`/committed）。
- 部署与仓库一致性：`curl https://ideaseek-t7xsgawx37d.qoder.zone/` 引用的入口是 `/assets/index-Cim3_YfU.js`，与本轮本地 `pnpm build` 产出的 `web/console/dist/index.html` 同一哈希——线上跑的就是这份构建，不是上一版。
- 访问模式 `public` 是负责人明确批准的那一步（private 下网关先于代码 401，实测项无法采集）；重新发布保留该策略。
