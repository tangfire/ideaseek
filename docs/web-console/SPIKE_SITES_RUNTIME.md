# Spike S1–S6：Qoder Sites 运行时实测记录

配套：[PLAN.md](PLAN.md) §3 · [REQUIREMENTS.md](REQUIREMENTS.md) · [DIAGRAMS.md](DIAGRAMS.md)

状态：**S1/S2/S3/S5/S6 已由平台官方文档给出确定答案；S4 的传输层上限与 S1/S6 的具体数值仍需在已部署实例上量测。**
本文同时纠正 PLAN.md §3 前言的一处错误前提，并把文档答案与实测答案分开登记——上一轮把未验证的 WebSocket 能力写成"已核实"，这一轮不能反向再犯一次：把"文档这么说"写成"我们这边跑通了"。

---

## 0. 前提纠正：本地文档是存在的

PLAN.md §3 原文写"平台侧关于 Sites Function 的运行时细节**没有本地文档可查**（本次调研已确认）"。这句是错的。

错因：调研只搜了 `~/.qoder-cn/`（用户资源目录）与 Qoder 的 `bundled-resources`，而 Sites 插件的参考文档随应用安装在扩展目录里：

```
D:/qoderCN/Qoder CN/resources/extensions/qoder.sites/dist/plugin/skills/
├─ sites-building/references/functions.md          ← Function 运行时契约、Secrets、身份
├─ sites-building/references/function-backend.md   ← Function 独占后端、注入凭据、RLS 归属
├─ sites-building/references/database-migration.md ← 受管迁移**支持的 SQL 子集**
├─ sites-building/references/static-site.md        ← 打包限制、路由命名空间、SPA 回退
├─ sites-building/references/environment.md        ← 本机工具与运行时表
└─ sites-build-agent-app/references/websocket.md   ← WebSocket 升级路径与边界
```

后果不是小事：正因为假定"无文档"，`web/migrations/0001_cloud_projection.sql` 的第一版是按通用 Postgres 写的，其中**全部 `CHECK` 约束、`text[]`/`uuid[]` 数组、`double precision`、`bigserial`、`BEGIN/COMMIT`、`IF NOT EXISTS` 与未限定的表名都不在受管迁移支持的子集内**——真去建 plan 会被整份拒绝。现在按子集重写了一遍（见 §2）。

"R4 的缓解措施就是这个 spike 本身"这条判断仍然成立；只是它的执行方式从"盲探"变成"先读权威文档、再对未给出的数值做实测"。

---

## 1. S1 — Function 运行时

**答案：Deno，edge 运行时，不是 Node。**（`functions.md:5`、`environment.md` 运行时表）

| 项 | 事实 |
| --- | --- |
| 入口 | `functionDirectory/index.ts`，打包为 `runtime/app.zip`，入口在 ZIP 根 |
| 逻辑名 | `app`；浏览器同域调用 `/functions/v1/app`（含子路径与 query） |
| 写法 | HTTP handler，例：`Deno.serve(handler)`；**不是** Express 常驻进程，也不是后台进程 |
| 构件 | `formatVersion: 2`，无 `authMode` 配置；数据库访问默认 `none` |
| 导入 | 相对路径 + 显式扩展名；打包器**不解析 TS 路径别名、不装依赖、不转换 Node 专有模块** |
| 禁止 | 把本地 `node_modules` 拷进 function 包；假定存在 import map 或远程下载服务 |
| 超时 | 文档未给数值 → **待实测**（下方 M-1） |

### 对本项目的直接后果：Function 侧不能再 import ajv

投影契约 `cloud-projection-v1` 原本设想"本地 ajv 校验 + Function 到货再校验一次"，两边共用同一个 JSON 文件。S1 之后，Function 侧不能 `import { Ajv } from 'ajv'`：打包器不装依赖，而 ajv 是带依赖图的 Node 包。

三条出路，建议第 (2) 条：

1. 把 ajv 的 bundle 提交进 `web/functions/shared/` —— 能用，但 vendor 一个 200 KB 校验器进 Git，且文档明确反对"拷 node_modules 解决问题"。
2. **构建期用 ajv standalone 模式把 schema 编译成自包含 ESM 校验函数**，产物落在 `web/functions/` 下。ajv 留在主线仓库当 devDependency，Function 包里没有第三方依赖，契约的**唯一真源仍是那个 JSON 文件**。代价：多一个 `pnpm build:function-schema` 步骤，且必须纳入 `release-check`，否则会出现"改了 JSON 忘了重编译，Function 还在按旧契约校验"。
3. 到货不再做结构校验，只信本地投影器 —— 不可接受：`additionalProperties:false` 的整批拒绝、fail-closed 的版本协商都需要在入口执行。

无论选哪条，这条依赖关系要写进 `docs/DEPENDENCY_POLICY.md`：**跨语言契约 = JSON Schema 真源 + 生成式校验器**，否则下一个人在 Function 里写 `import Ajv` 会得到一个部署期才炸的错误。

### 待实测（M-1）

单次请求最长执行时间、冷启动行为、`fetch`/`crypto` 在 edge 下的可用面（文档提到 `Deno.env.get`、`Deno.upgradeWebSocket`，说明是较完整的 Deno API，但没给白名单）。

---

## 2. S2 — Function 连库与受管迁移

**答案：能连，能建表，但 DDL 是一个受限子集，且迁移不是"跑 SQL"而是"提交 plan → 校验 → 应用 planRef"。**（`function-backend.md`、`database-migration.md`）

受管子集（`database-migration.md:11-24`）：

- 语句：仅 `CREATE TABLE app.<t>`、`ALTER TABLE app.<t> ADD COLUMN`、普通 `CREATE INDEX ... ON app.<t> (<cols>)`。**不支持**自定义函数、触发器、任意 SQL、policies。
- 类型：`boolean` / `integer` / `bigint` / `text` / `uuid` / `timestamptz` / `jsonb`。**数组、`date`、`timestamp`、`numeric`、`varchar(n)`、`double precision` 都不在列**。
- 约束：`NULL` / `NOT NULL` / `PRIMARY KEY` / `UNIQUE` / app 内 `REFERENCES`。默认值只支持 null/布尔/整数/文本字面量与 `gen_random_uuid()`、`now()`。**`CHECK`、生成列、identity/serial 不支持**。
- 新增列必须可空且无默认值。
- 索引：只允许普通列名，无 `ASC/DESC`、无 NULLS 排序、无表达式、无 `WHERE`（部分索引）。
- DML 与种子数据一律不进迁移。

因此 `web/migrations/0001_cloud_projection.sql` 的改动与代价：

| 原设计 | 现状 | 代价与去处 |
| --- | --- | --- |
| 每列的 `CHECK`（长度 ≤400、`sha256:` 形状、路径无 `..`、withheld 假设不得带全文） | 全部删除 | 不变量改由 **cloud-projection-v1 + Function 写路径** 承担。这**不是等价替换**：库不再拒绝绕过 ingest 直连的写入。缓解：function_backend 生成的固定私有策略使浏览器根本拿不到库，唯一写入者就是 ingest 路由 |
| `numeric`/`double precision` 存指标值 | `value_text` / `variance_text` / `delta_text` | Function 侧解析并拒绝 `NaN`/`Infinity`；聚合与比较本来就在 JS 侧做（读路径唯一入口）。附带好处：0.12 不会因浮点往返变成 0.12000000000000001 |
| `text[]` / `uuid[]`（scopes、project_scope） | `jsonb`，形状在 Function 校验 | 无 |
| `bigserial`（live_outbox 帧序） | `uuid` 主键 + `seq bigint`，由 Function 赋值 | 并发赋值方案待定，见 §4 的 S4；退路是按 `(project_id, run_external_id, seq)` 用本地事件序号排序，那正好是 WS-04 断点续传需要的游标语义 |
| `ON DELETE CASCADE` | 删除 | 子集没有列出 referential action；删除走 UC-22 的显式删除路径，语义反而更明确 |
| `index` / `text` 作列名 | `round_index` / `claim_text` | 不是 Postgres 保留字问题，是不去赌一个自研 DDL 解析器 |
| `BEGIN/COMMIT`、`IF NOT EXISTS`、部分索引 | 删除 | 迁移由平台按 plan 原子应用；"只取 listed / 只取未撤销"这类过滤移入 Function 的 WHERE |

连库方式：平台在部署前把 `QODER_DATABASE` 注入 Tenant Secrets，SDK 每次 HTTP 执行时读取；**不得**用 service_role、不得把库凭据给浏览器、不得由 JSON 里自带的 owner 决定归属（`function-backend.md:47-60`）。

`prepare_site` 侧：`databaseAccess: read_write` + 与同一 `projectId` 的 `schemaRef`（来自 `get_database_schema`）；`schema.sql` 必须放在 function 目录之外，打包器从不内嵌或执行 SQL。

### 待实测（M-2）

受管解析器对这份 0001 的**实际**接受度：`REFERENCES` 不带 ON DELETE 是否通过、`DEFAULT gen_random_uuid()` 主键、`UNIQUE (a,b)` 表级写法、以及一次 plan 应用要多久。这个只能建了站才知道，属于 S2 的剩余部分。

---

## 3. S3 — SPA 回退

**答案：支持，用 `prepare_site.spa: true`，平台生成 `index.html` 兜底且返回 200。**（`static-site.md` 路由表）

两条附带约束：

1. 目录索引恒关闭：`/guide/` 不会解析到 `/guide/index.html`，页面互链必须写实际文件路径。
2. SPA 兜底意味着**缺失的脚本路径也会返回 HTML 200**。所以"资源加载成功"不能只看状态码，要看 content-type 与响应体——这正是我们诊断文档里提醒过的那类假阳性。

原设计用 hash 路由规避深链问题，现在 `spa: true` 可用，但**保留 hash 路由**：它与"静态托管 + 不依赖服务端 rewrite"的降级路径同构，S3 失败面为零。

---

## 4. S4 — 请求体上限与写频

**答案：只答了一半。**

已知的打包/传输侧数值（`static-site.md:44-49`）：单目录扫描 10 000 文件、单文件 50 MiB、Web 内容 450 MiB、Function 内容 50 MiB、本地 ZIP 100 MiB 而 Worker 侧更严（50 MiB）。交付物按 50 MiB 以内规划。

**未知、必须实测**：单次 `POST /functions/v1/app/ingest` 的请求体上限、每分钟写入次数/并发限制、以及托管库单事务的行数上限。这三项直接决定 push 批大小与兜底心跳间隔。契约里已经按保守值写了每类实体的 `maxItems`（events 5 000、claims 50 000…），M-3 之后按实测收紧，不反过来。

### 待实测（M-3）

从 256 KB 起倍增探边界，直到 413；以及连续写入的限速表现。顺带解决 `live_outbox` 的 seq 赋值并发问题（§2 表中的退路二选一）。

---

## 5. S5 — 行级/列级访问策略

**答案：不是"能不能表达"的问题——平台不让我们在库里表达，判定位置在 Function。**

- `function_backend` 下 **AppHub 生成固定私有策略**，`prepare_site.accessPolicies` 应省略或传 `[]`；不要把 legacy 的 public/owner 示例抄过来（`function-backend.md:33-37`）。
- 平台文档原话："Database RLS isolates Tenant; **Function predicates enforce users, roles and resource ownership within the site**."（`function-backend.md:59`）—— 租户之间靠 RLS，同一站点内部的用户/角色/资源归属靠 Function 的 SQL 谓词。
- 迁移子集也明确"用声明式 accessPolicies 代替裸 GRANT/RLS 语句"，且 policies 走独立通道（可以只改策略不改 DDL）。

所以原设计里"S5 若判定支持 RLS，则追加 0002 把判定下推"这一分支**作废**：可见性判定从第一版就落在 Function 谓词，L1 列（claim 文本、假设全文）由 Function 决定 SELECT 哪些列，而不是由策略决定谁能看哪列。物理分表（`cloud_public_*`）仍是一个可选的实现优化，但不再是为了"绕开不支持列级策略"的降级。

两类主体要分清（这条之前没有明确写下来）：

| 主体 | 凭据 | 校验方式 |
| --- | --- | --- |
| 浏览者（浏览器） | Qoder 同域登录态 | 网关校验后向 Function 注入 `x-qoder-user-context`；用 `getUser(request)` / `requireUser(request)` 读取 |
| 本地引擎（投影器） | 我们自己的应用 Secret + `cloud_sync_token.token_hash` | Function 比对哈希、检查 `revoked_at`；这是机器对机器的写凭据，不走 Qoder 身份 |

`cloud_sync_token` 因此保留，但语义要改清楚：它不是"云端签发访问令牌"的表（平台不提供这种能力），而是**写入侧的机器凭据台账**。

诚实性要求：`functions.md:41` 明确"SDK 只校验格式，不校验签名"，并且一次同域请求成功**不等于**建立了防伪造边界——要证明的是"绕过网关直连 Provider / 备用入口 / 跨租户路由"都拿不到数据。这一条属于隔离验证，不是功能验证，M2 的安全验收必须单列，且在结论出来之前不得声称"仅 Owner 可读"。

---

## 6. S6 — WebSocket 长连接

**答案：支持。** 之前登记为"未验证前提"，现在升级为"文档确认 + 官方一次性实测记录"，但**不等于我们的实例已验证**。

- 实现方式：`Deno.upgradeWebSocket(request)`，就在同一个 `app` Function 里（`websocket.md:8`）。"A WebSocket Upgrade is an HTTP request handled by the Function, not a request to start a persistent Node server."
- 浏览器连接：`wss://${location.host}/functions/v1/app?action=ws-echo`（本地为 `ws:`）。`action` 是示例自己实现的，不是平台端点。
- 官方留有一份参照实现：`assets/websocket.mjs` 提供 `relayWebSockets()` 与边界控制（消息大小/条数、缓冲上限、连接寿命），可直接拷进 function 目录复用。
- 参照实现的默认边界：单消息 256 KiB、排队输出 512 KiB、每连接 3 000 条、上游握手 10 s、连接寿命 55 s；echo 把单消息降到 4 KiB。**文档明确说这些是示例配置，不是 Sites 的配额**。
- 已知的一次真实结果：2026-09-20 一次全局 PROD 检查，浏览器 → Function echo，1 500 × 640 字节帧 @ 20 ms 间隔，零错配，约 30 s。文档同时声明"不为其他环境、长寿连接或带凭据的出站中继背书"。
- 与我们的契约吻合处：浏览器 WS **不能**带自定义 `Authorization` 头 → 同域登录态是唯一路径（正是 WS-05 的设定）；平台要求对 `Origin` 做白名单校验（正是 WS-06）；`binaryType='arraybuffer'` 支持二进制帧。

结论对工期的影响：REQUIREMENTS.md 里"WS 不通则降级 15 s 短轮询"的分支从**主线备选**降为**兜底预案**，`live_outbox` 与帧语义两种传输下都成立，所以 §2.1 主流程图不必重画。

### 待实测（M-4）

本平台实例上的：握手是否真能 101、单实例并发连接上限、连接存活时长上限、空闲断开策略。文档建议的措辞我们要照抄进结论——"**在选定产品参数前先量测部署运行时的 idle timeout、lifetime、traffic 与 concurrency 上限**"。在 M-4 出来之前，REQUIREMENTS.md 中"≤1 s 到达"的 NFR-16 目标只能标注为"依赖未量测的连接寿命"，不能宣称达标。

---

## 7. 顺带纠正的一处契约错误：路由命名空间

`static-site.md:32` 把 `/api`、`/functions`、`/internal`、`/storage`、`/rest/v1`、`/__qoder_*` 列为平台保留命名空间，并写明"`/api` **不是**本平台默认的应用 Function 入口"。而 REQUIREMENTS / DIAGRAMS / PLAN / FEATURE_LIST 与 schema 描述里的端点全部写成了 `/api/ingest`、`/api/live`、`/api/views/*`、`/api/approvals/*`——照写会撞保留前缀。

已统一改为：

```
POST /functions/v1/app/ingest              本地投影器写入（机器凭据）
GET  /functions/v1/app/views/*             首屏全量（REST）
GET|WS /functions/v1/app/live              增量帧（S6）
POST /functions/v1/app/approvals/:id/intent 审批意向（只写 intent）
```

Function 侧匹配的是剥掉前缀后的业务路由：网关会把逻辑名 `app` 替换为上游物理名并保留后缀与 query，因此**代码不得假定收到的完整路径里含有 `app`**，且"未知路径不得一律返回成功"（`functions.md:25`）。

---

## 8. 剩余实测清单

| ID | 要量什么 | 阻塞谁 | 状态（2026-11-22 部署实测，见 §10） |
| --- | --- | --- | --- |
| M-1 | Function 单次执行超时、`fetch`/`crypto` 可用面 | 投影器的批大小与心跳；契约生成物是否能在 Function 里跑 | **已量**：超时上界落在 (50 s, 60 s]；`fetch`/`crypto.subtle`/`crypto.randomUUID`/`Deno.env` 全部可用 |
| M-2 | 0001 这份 DDL 被受管解析器实际接受的程度 | M1 出口（建表交付物）、M2 投影器 | **已量**：26 张 `cloud_*` 表建成，Function 读到行数；受管 DML 不套列默认值（见 §10.5） |
| M-3 | ingest 请求体上限、写频/并发限制 | push 批大小、兜底心跳间隔、`live_outbox` seq 方案 | **部分**：请求体上限 ∈ [8 MiB, 32 MiB]（16 MiB 为连接级失败）；**写频与并发未量** |
| M-4 | WS 握手、并发、存活时长、空闲断开 | NFR-16 能否成立；是否启用 §2.1 的轮询兜底分支 | **已量**：握手可达 101，55 s 服务端收线，4 KiB 帧上限生效；单实例并发上限**未量**（只量到 5 条） |
| M-5 | 防绕过验证：Provider 直连、备用入口、跨租户 | "仅 Owner 可读"这类隔离声明能否成立（S5 的诚实性前提） | **未量**，属 M2 安全验收 |

M-1…M-4 需要一个已部署的 Function；M-5 需要专门设计反例请求，属于 M2 安全验收而非 M1 骨架。

---

## 9. 本 spike 改变了哪些交付物

1. `web/migrations/0001_cloud_projection.sql`：按受管子集重写（表名进 `app.`、去 `CHECK`/数组/`numeric`/`bigserial`/事务/部分索引/`ON DELETE`）。
2. `src/core/schema/schemas/cloud-projection-v1.json`：`comparison.source_hint` 增加凭据 pattern；`idea` 增加 `allOf/if/then` 的假设一致性规则——**这两条正是从被删掉的 DDL CHECK 搬上来的**，且位置更靠前（本地 ajv 在字节出境前就拒绝，列约束要等入库才发现）。
3. 文档端点全部改到 `/functions/v1/app/*`。
4. `PLAN.md` §3 前言与技术栈表的"未验证"标注按本文结论更新；S6 从"主线风险"降为"数值待测"。
5. 新增待办：Function 侧契约校验器改为构建期生成（§1 方案 2），并把该生成步骤纳入 `release-check`。

---

## 10. 部署实测（M-1/M-2/M-3/M-4 的真实读数）

站点：`https://ideaseek-t7xsgawx37d.qoder.zone`（projectId `01a20236-0bb5-70d0-8725-85eb306c8203`，siteId `01a20236-0bb8-7b28-97ba-6d14e9abbfad`）。Function 首次成功发布 `actionId 4d7e2a18-9b3c-4f52-a0d6-8c1e5f74b209`，文案与读数修正后的第二次发布 `actionId 0db688ef-9fa9-4d2c-a768-41bdcadc02e4`（publish operation `01a202a7-89aa-72c3-85b4-d7c05f83036c`，state `succeeded`/committed）。日期均为 2026-11-22，UTC。

**前置说明：这一批读数只能在公开站上取。** `private` 模式下网关在我们的代码之前就把静态页与 `*/functions/*` 一律 401（`x-qoder-error: sites_gateway_login_required`），而 Owner 登录是浏览器人机流程——**不代为登录、不索取凭据**是红线，所以转公开是负责人明确批准的那一步（不是默认动作，也不是可以悄悄做的动作）。发布流程保留负责人选择的访问策略，重新发布不会把它改回去。

### 10.1 第一次部署没起来：`_qoder/backend.mjs` 的真实导出面

上传后 Function 启动失败：`does not provide an export named 'getUser'`。平台注入模块的导出面**只有四个**：

```
createDatabaseClient  createSiteContext  errorResponse  BackendError
```

`functions.md` 里读到的 `getUser` / `requireUser` 是参照实现里的写法，不是这个模块的导出。修复方式照 §5 的边界：把身份判定的代码搬进我们自己的包（`web/functions/auth.mjs`，与插件 `assets/user-context/auth.mjs` **逐字节相同**，sha256 `b406e1c5b6545cf2812d85281ab0d9d02e61ff8db06ec929ccf11e336d9d20c8`），`identity.ts` 只做一件事——把 `getUser(request)` 收成 `{ id: user_id } | null`，`index.ts` 只 import 那四个真实导出。`web/functions/` 因此**不 import `_qoder/backend.mjs` 里不存在的名字**，也不留 `node_modules`。

代价要说清楚：`auth.mjs` 是 vendored 的，平台升级它的校验规则时我们不会自动跟上（M-5 的反绕过验收里要有这一项）。

### 10.2 网关到底剥掉哪些头（`/probe/ingress` 的读数）

为了回答"凭据有没有走到 Function"新加了一条**不鉴权、只报布尔与头名、永不回显值**的探针。终端请求带 `x-ideaseek-token` + `authorization` 时读到：

| 观测 | 读数 |
| --- | --- |
| `authorization` | **false**（被剥） |
| `x-ideaseek-token` | **true** |
| `x-qoder-user-context` | false（未登录态请求，本来就没有） |
| `header_count` | 21（含 `original-host`、`req-start-time`、`x-request-id` 等网关注入项） |

结论：**机器凭据只能走自定义头**。`SYNC_TOKEN_HEADER = 'x-ideaseek-token'` 是部署态唯一可用载体，`Bearer` 那条继续支持（Provider 直连与本地入口带得动），两条路都有断言守着（`test/routes.test.ts` 最后两例）。

顺带纠正一处 §5 之前的推定：登录态注入 `x-qoder-user-context` 这条**仍未实测**——我们没有登录态请求可发（不代登录）。所以"浏览器带着同域登录态访问时 Function 能不能认出 Owner"目前只有代码与合成上下文测试，**没有部署读数**，挂在 M-5。

### 10.3 写侧同源闸门：Origin 不是可选的

所有 POST 在**没有** `Origin: https://ideaseek-t7xsgawx37d.qoder.zone` 时返回 `403 {"code":"sites_gateway_origin_forbidden"}`。这是网关的 CSRF 防线，不是身份验证（脚本化投影器加一个头就过），但**M2 的投影器必须把它当作契约的一部分**，否则本地 `cloud push` 会稳定撞 403 而看不到原因。

### 10.4 边缘还有一道反机器人闸门：空 `User-Agent` = 403

`node:https` 裸请求（无 UA）打到 Function 路径上：`403` + `x-blocked-reason: Empty User-Agent` + `{"code":"BOT_DETECTED"}`。这不是我们的代码，是站点的边缘层。踩中方式是 `ws` 客户端——它默认不发 UA；Node 的全局 `fetch` 默认发 `user-agent: node`，所以前面的 HTTP 读数全都过了闸。

因此两条硬约束：**任何脚本化客户端（M2 投影器、CI 冒烟、本地验收）必须显式带非空 `User-Agent`**；WS 握手同样要带。文档里没有这一条，靠猜一定踩。

### 10.5 M-1：执行超时与请求体上限

| 探针 | 读数 |
| --- | --- |
| `deno_version` | `supabase-edge-runtime- (compatible with Deno v1.45.2)`，V8 `11.6.189.12`，TS `5.1.6` |
| 能力位 | `has_fetch` / `has_crypto_subtle` / `has_random_uuid` / `has_upgrade_websocket` **全 true** |
| `env_probe` | `readable=true`、`getter=true`、`names=["QODER_DATABASE","QODER_STORAGE"]` |
| `sleep` 1/15/30/40/50 s | 全部 200，`elapsed_ms` 与请求一致（+1 ms 级误差） |
| `sleep` 60 s | **`504 upstream request timeout`**（60 183 ms 处断开） |
| `body` 1/4/8 MiB | 200，`received_bytes` 精确 |
| `body` 16 MiB | **连接级失败，没有 HTTP 状态**（`fetch failed`） |
| `body` 32 MiB | `413 {"message":"Request size limit exceeded"}` |

对交付物的直接影响：①单次执行的可用预算是 **(50 s, 60 s)**，投影器一批的墙上时间要按 45 s 封顶设计；②`Deno.env` 在这个运行时**可读**（`toObject` 与 `get` 都在，只报名字不取值），所以 §1 里"Function 没有 env 权限"的推定作废，`routes.ts` 的注释已按新读数改写；③请求体安全上限取 **8 MiB**，且要按 §10.4 一样显式处理超限——16 MiB 那一档连错误码都没有，只靠 `413` 分支做重试会把"连接被掐"当成网络抖动无限重试。

### 10.6 M-2：受管 DML 的形状（建库之外能用什么）

`/probe/db` 在合成链跑完后读到 `cloud_project / cloud_run / cloud_run_event / cloud_sync_batch / live_outbox = 1 / 1 / 1 / 1 / 1`，`cloud_*` 共 26 张表（`get_database_schema`，schemaRef `sr_Ujpn_ZTL5gyHwPkCOK_LG1WM8sDCP9OKHw…`）。写入侧实测到的约束：

- `insert_database_rows` **不套列默认值**：NOT NULL 列必须显式给值，`id`（uuid 文本）与 `created_at`（RFC3339 文本）都得调用方自己生成。所以 §2 里"Function 依赖库默认值"的想法不成立，M2 的投影器要自己生成 id 与时间戳。
- `type` ∈ `text|integer|boolean|json|null`，**值一律是字符串**；`bigint`/`jsonb` 读回来仍是字符串形式，精度要在应用侧解析。
- Owner 侧管理写入（`update_database_row`）要求**完整主键 + UUID `requestId`**，且没有 CAS：同一 `requestId` 与同一参数是唯一的恢复路径，不能"失败了就换个 id 重发"。

### 10.7 M-4：WebSocket 的四项数值

`wss://…/functions/v1/app/probe/ws-echo`，握手带 `x-ideaseek-token` + `Origin` + `User-Agent`（原因见 §10.4）：

| 要量的 | 读数 |
| --- | --- |
| 握手能否 101 | **能**，单连接 173–276 ms 打开 |
| 往返延迟 | echo RTT **65 ms**（同帧，含网关与 Function） |
| 并发 | 5 条同时打开 211–240 ms，**全部回显**；更高并发未测（不是"没有上限"，是"还没找上限"） |
| 消息上限 | 5 000 字节帧 → `close 1009 message_too_large`（我们的 4 KiB 闸生效，平台侧更早的闸未观测到） |
| 连接寿命 | 空闲 **55 232 ms** 后 `close 1000 lifetime`（= 我们自设的 `LIFETIME_MS 55_000`，先到的是我们自己的定时器） |

**S6 判定：通过**，`live_outbox` + 帧语义按 WS 走，15 s 轮询降级为兜底分支（且已在部署上真实可用：`GET /live` 有帧回 200、无帧回 304）。

**S6 通过标准里最硬的那一条也已实测**（PLAN §3 原文："服务端在另一次 push 到达时**主动**把变更帧推下来，不是浏览器轮询出来的"）：客户端在 `/live?action=live&project=spike-m1-demo` 建立长连接（握手 411 ms）后**不再发任何请求**，另开一条 `POST /ingest` 投新批（`200 accepted`，`counts {runs:1,stages:0,events:1}`），**1 354 ms** 后同一条已打开的 WS 上收到 `{"type":"state",…,"seq":2}` 帧。这条链的形状由此定死：ingest → `live_outbox` → Function 侧 2 s 泵 → 已连接的浏览器；主动推的延迟取决于 `IDLE_POLL_MS`，不取决于浏览器刷新节奏。

两处坑要记下来，否则下一个人还会踩：

1. **`/live` 只认 `?action=live`**（`web/functions/live.ts:112`）。带 WS 升级头但没带这个 query 时，路由走轮询兜底分支、回的是普通 `Response`；网关在升级请求上拿到非 101 就把它变成 **`502` 且正文为空**——看起来完全像"平台不支持 WebSocket"，实际是我们自己的分支条件。浏览器侧能连上，正是因为前端一直发 `?action=live`。
2. 批里引用 `run-…` 必须**同批把 runs 一起带上**，否则 `400 事件引用了批内不存在的运行`；`external_batch_id` 的 `^[a-z]+-[0-9a-f]{16}$` 也拦下了第一版脚本（`…a7live` 不是十六进制）。两条都是契约按预期 fail-closed，不是缺陷。

仍未知的两项：平台的并发连接天花板（只试到 5 条）、平台侧是否有比 55 s 更早的收线（先到的是我们自己的定时器）。**这两项要在 M3 之前找出来，不能假定 55 s 是我们独占的**。

### 10.8 读侧与验收：伪造投影 → 云端库 → 浏览器深链

同一条合成批（`bat-…9e947b`，`spike-m1-demo`）投进真实云端库之后的读数：

| 验收项 | 结果 |
| --- | --- |
| ingest 首轮 | `200 accepted`，`counts {runs:1,stages:1,events:1}` |
| 同一 `external_batch_id` 重放 | `200 {"status":"replay"}`，**不二次写入**（F1.8） |
| 匿名读私有项目 | `404 not_found`（不是 403，不确认存在性） |
| 匿名列表（无 listed） | `projects: []` |
| 拨成 `listed` 后的 L2 详情 | `projection_level:"l2"` + 11 项 `redacted_fields`；正文中查不到 `status`/`block_reason`/`spent_usd_micro`/`gate_note`/`strategy`/`autonomy`，事件数组为空（F5.2 在库层生效） |
| `GET /live?project=…` | 200 + `state` 帧（seq 1）；`since=99999` → **304** |
| 浏览器 hash 深链 | `#/p/spike-m1-demo` 渲染 L2 视图：降级横幅、阶段链、"事件摘要不在公开降级投影（L2）这一级"、传输位显示"服务端推送"（浏览器 WS 真连上了） |
| 拨回 `private` 之后 | 同一批匿名读全部回到 404 / 空列表（F5.6 的读侧） |

两处随之修正的界面诚实性问题（都是这轮实测暴露的，不是事前想到的）：L2 下 `strategy=未记录` 会被读成"引擎没记录"，实际是被有意扣下，改成"不在这一级"；传输位原写"实时推送"，撞 REQUIREMENTS §3.4 的措辞红线（R3），改成"服务端推送"。**发布后浏览器仍可能用缓存的旧 bundle**：`index.html` 与哈希资产的 `cache-control` 都是 `no-cache`，但已经渲染过的页面不会自动换模块——验收必须硬刷新，否则会把"没生效"读成"生效了"。

### 10.9 这轮没有验证的东西（悲观清单）

1. **登录态注入未实测**（§10.2）：Owner 的 `full` 视图在部署上仍未走过，只有合成上下文测试。
2. **M-5 防绕过全未做**：Provider 直连、备用入口、跨租户隔离、vendored `auth.mjs` 的校验强度，全部挂在 M2 安全验收。
3. **写频与并发未量**（M-3 只量了单次请求体）：投影器的批量与心跳只能先按 §10.5 的时间预算设计，不能声称"平台允许"。
4. **WS 并发天花板未量**（§10.7）。
5. **`user_id → cloud_owner.email` 映射是本次决定**（`views.ts:63`，首次登录按需建行）：它让"同站登录态即 Owner"成立，但也意味着**站内的任何已登录账号都会自动获得一个 Owner 主体**，能看到自己投影出来的项目。这对公开站是可接受的默认（数据由本人推上来），但它不是平台保证，是我们写的规则——M4 公开上线检查单里要重新看一次。
6. **ajv standalone 生成器仍未做**，Function 侧契约校验目前是 `contract.ts` 里手写的白名单与 `additionalProperties` 拒绝。理由：手写只覆盖现在这三个集合，M2 一旦把 17 个集合放开，手写就会变成"看起来严、实际漏"的那种实现；届时按 §1 方案 2 换成构建期生成，并把该步骤纳入 `release-check`。
