# 账号体系与项目 CRUD 改造方案

状态：**待批准**（§10 有 5 个决策点未回）
诉求来源：2026-11-24 用户提出两条——① "随便可以注册然后登录就行了，账号密码注册登录，弄一个简单的，记得权限隔离，登录了只能看到自己的内容"；② "这些项目要弄一下增删改查，就是基础的 CRUD"
本文只解决这两件事，不碰工作流引擎、不碰 LLM 渠道、不碰可见性以外的投影语义。

---

## 1. 结论先行

当前站点的权限是**形同虚设**的：读面完全不设防，写面靠平台账号，等于"注册个平台账号就能看别人的东西、改不了也删不掉"。项目 CRUD 里 **C 和 R 能用，U 和 D 是死的**。

判定这次改造完成的四条硬标准：

| # | 判据 | 当前 |
| --- | --- | --- |
| G1 | 未登录只能读到 `listed` 项目的 L2 投影；登录后列表**只有自己的项目**（+ 官方演示） | 不通过（`canRead` 恒 `true`，列表列全部项目） |
| G2 | 用户 A 登录后读不到、改不了、删不了用户 B 的项目（非 owner 一律 404，不泄露存在性） | 不通过（读面无判定；写面只验"登录了没"，验不了"是不是 owner"以外的隔离） |
| G3 | 改标题 / 改研究问题 / 改可见性：保存即生效（≤1 s），不再出现"已提交但没变化" | 不通过（`project_settings` 只入队，云端无执行者） |
| G4 | 删除项目后，该项目所有读接口 404，子表数据一并清掉（NFR-05 被遗忘路径） | 不通过（`DELETE /projects/{id}` 路由不存在，404） |

---

## 2. 现状证据（每条都可复现）

### 2.1 权限：读面恒真，写面只认平台身份

| 位置 | 现状 | 后果 |
| --- | --- | --- |
| `web/functions/views.ts:130-133` | `canRead()` 函数体是 `// 临时放开所有权限，允许任何用户访问任何项目` + `return true` | **任何访客（含完全匿名）能读任何项目的 full 投影**，包括别人的 `private` 项目 |
| `web/functions/views.ts:137-140` | `readLevel()`：登录用户访问**匿名 Owner** 的项目 → `full` | 所有人共用的匿名 Owner 名下项目对任何登录者敞开 |
| `web/functions/views.ts:216-232` | `projectIndex()` 列出所有未归档项目（按 `last_sync_at` 倒序，上限 200） | 列表里混着别人的项目、QA 残留项目，"太乱"的来源之一 |
| `web/functions/identity.ts:26-29` | 身份 = 网关注入的 `x-qoder-user-context` → `cloud_owner.email` | 没有自有账号体系；**谁能注册平台账号，谁就是"合法用户"** |
| `web/console/src/api.ts:151` | 登录入口 `loginHref()` → `/__qoder_auth/start`（平台登录页） | 与"账号密码注册登录"的产品诉求不一致 |
| 实测（2026-11-24） | `POST /commands/project_settings` → `401 login_required`；`GET /views/project?...` → `200`（匿名） | **读不要登录，写才要登录**——与直觉相反，也与"登录了只能看自己的"相反 |

### 2.2 CRUD：U 和 D 是死的

| 动作 | 入口 | 实际链路 | 结论 |
| --- | --- | --- | --- |
| **C** 创建 | `POST /projects` → `projectCreateView` → `executeInCloud` | 白名单只有 `project_create`（`commands.ts:534-537`），云端真执行，返回 `cloud_executed: true` | ✅ 可用（空研究问题已修，704587e） |
| **R** 读取 | `GET /views/index`、`GET /views/project` | 直接查投影 | ✅ 可用（但权限没隔离，见 2.1） |
| **U** 更新 | `POST /commands/project_settings` → `enqueueCommand` | **只插一行 `cloud_command`（status=queued）就返回**；`executeInCloud` 白名单不含它；队列唯一消费者 `/agent/heartbeat` 属于已删除的 local-agent | ❌ 永远 `queued`，投影不变。前端却提示"命令已提交"——**界面对用户说谎** |
| **D** 删除 | 无 | `DELETE /functions/v1/app/projects/{id}` → `404 not_found`（2026-11-24 实测）；`project_archive` 同样只入队 | ❌ 不存在。NFR-05（REQUIREMENTS:229"Owner 可一键删除项目全部云端投影，删除后所有读接口 404"）从未实现 |

### 2.3 测试基线（改造前）

`97 项 / 77 过 / 20 失败`，20 条失败构成（逐条比对过，非本次引入）：

- **6 条**：ACL 演示放开导致（`access.test.ts` 的匿名 404、share 降级、Owner full 等）——**本次修复 `canRead` 后应转绿**
- **12 条**：local-agent 时代断言（"创建项目排成命令而不是写投影"、"设置与归档只能排队"、幂等回放系列等），断言对象是已删除的子系统
- **2 条**：Node 20 无 WebSocket 的环境限制（`/live` 握手、`no-store`）

---

## 3. 对 REQUIREMENTS 的修订（需要同步改文档）

| 条目 | 原文 | 改为 |
| --- | --- | --- |
| A1 项目所有者 Owner | 身份来源 "Sites 平台身份" | 身份来源 **自有账号（用户名+密码）**；平台网关身份退出业务鉴权，只负责静态资源与 Function 入口 |
| A2（新增）注册策略 | 无 | **开放注册**：任何人都能注册用户名+密码，注册即得自己的 Owner 空间 |
| 可见性 `listed`（REQUIREMENTS:116） | 出现在公开项目列表中 | 语义拆成两条：**直链可读 L2** 保留；**是否混进他人列表**改为不混进（见 §10 D1），列表 = 自己的 + 官方演示 |
| NFR-05（:229） | Owner 可一键删除全部云端投影 | 本次实现（§5.3） |
| NFR-02（:226） | sync_token 只存哈希 | **推广到会话 token 与密码**：只存哈希，可单项吊销 |

---

## 4. 方案 A：账号、会话与权限隔离

### 4.1 数据模型（migration `0007_account_session.sql`）

```sql
-- 账号：用户名唯一（小写存储），密码只存 PBKDF2 派生值
CREATE TABLE app.cloud_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL,
  password_hash   text NOT NULL,          -- 'pbkdf2$<iterations>$<salt_b64>$<hash_b64>'
  display_name    text,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);
CREATE UNIQUE INDEX idx_account_username ON app.cloud_account (lower(username));

-- 会话：库里只有哈希，明文只在 Cookie 里（NFR-02 同款纪律）
CREATE TABLE app.cloud_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES app.cloud_account(id),
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  user_agent   text
);
CREATE INDEX idx_session_account ON app.cloud_session (account_id);
CREATE INDEX idx_session_expires ON app.cloud_session (expires_at);

-- Owner 与账号挂钩：既有 cloud_owner 行（平台身份 / 匿名）保持不动，新增可空外键
ALTER TABLE app.cloud_owner ADD COLUMN account_id uuid REFERENCES app.cloud_account(id);
CREATE UNIQUE INDEX idx_owner_account ON app.cloud_owner (account_id) WHERE account_id IS NOT NULL;
```

迁移规则沿用 0006 的纪律：**只加表、加可空列、加索引**，不改既有列语义，旧代码不受影响。

### 4.2 接口

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| POST | `/auth/register` | `{username, password, display_name?}` | 201 + `Set-Cookie` + `{ok, username}`；用户名已存在 → 409 |
| POST | `/auth/login` | `{username, password}` | 200 + `Set-Cookie` + `{ok, username}`；凭据错 → 400，**不区分"用户不存在/密码错"** |
| POST | `/auth/logout` | — | 200，`revoked_at=now` + 清 Cookie |
| GET | `/auth/me` | Cookie | 200 `{username, owner_id}` 或 401 |

**校验与防护（缺一不可）**：

- 用户名：`3-32` 位，`[A-Za-z0-9_-]`，小写存储，唯一索引兜底
- 密码：`≥8` 且 `≤128` 字符（上限防哈希 DoS）；**不做复杂度规则**（"弄一个简单的"）
- 哈希：PBKDF2-SHA256，**310 000** 次迭代（OWASP 2023 下限），每账号 16 B 随机盐，`crypto.subtle` 实现（Deno 原生，零依赖）
- 比较：常数时间（逐字节 XOR 累加），防时序侧信道
- 暴力破解：`failed_attempts` 累加，**连续 10 次失败锁 15 分钟**（`locked_until`）；登录成功清零
- 注册/登录限流：同 IP 60 s 内 ≤ 10 次（DB 计数窗口，Function 无状态所以不能用内存）
- 错误文案不回显内部标识；密码字段绝不进事件/日志/错误栈（红线 §9）

### 4.3 会话与 Cookie

- Cookie 名 `is_session`，值 = 32 B 随机 token 的 base64url 明文；**库里只存 `sha256(token)`**
- 属性：`HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000（30 天）; Secure`
- 轮换：登录时新建会话（不复用），登出置 `revoked_at`；`expires_at` 到期即失效
- 请求侧：`resolveViewer` 读 `Cookie` → 查 `cloud_session`（`revoked_at IS NULL AND expires_at > now()`）→ 得到 `ownerId`

**M0 必做的平台探针（决定方案成败，半天）**：

| 探针 | 为什么关键 | 通过标准 |
| --- | --- | --- |
| Function 返回 `Set-Cookie` 是否穿透网关到浏览器 | 整套会话方案的地基 | 浏览器 `document.cookie`（非 HttpOnly 侧）与后续请求 `Cookie` 头都能看到 |
| 浏览器请求自动带 `Cookie` 到 `/functions/v1/app/*` | 同源自动携带，理论必然，但网关可能剥 | `GET /auth/me` 返回 200 |
| WS 握手带 Cookie | `live.ts` 的实时帧；WS **不能带自定义头**（SPIKE §10 实测 `authorization` 被网关剥掉） | `openLive` 连上后能收到 `state` 帧 |

若 **Set-Cookie 被剥**（唯一可能的失败），降级路径：登录响应把 token 放 JSON，前端存内存 + `localStorage`，REST 走 `x-ideaseek-session` 头，WS 走 query 参数 `?session=`。代价是 token 会出现在 URL 与访问日志里，必须配 **10 分钟短 TTL + 每次握手轮换**。文档先写明，避免到现场再吵。

### 4.4 鉴权收口（`resolveViewer` 重写 + 三处判定恢复）

```
请求 → Cookie → cloud_session → ownerId（有）
                              → 匿名（无/失效）
```

| 位置 | 改动 |
| --- | --- |
| `identity.ts` / `auth.mjs` | **不再参与业务鉴权**。`x-qoder-user-context` 读取逻辑保留文件但 `resolveViewer` 不调用（避免留"平台账号=万能钥匙"的后门，见 D3） |
| `views.ts:130 canRead` | 删掉 `return true`，恢复真实判定：owner 自己 → 通过；`grantedProjectIds`（受邀）→ 通过；`shareProjectId` 匹配或 `visibility='listed'` → 通过（L2）；**其余一律拒绝** |
| `views.ts:135 readLevel` | 删掉第 140 行"登录用户访问匿名 Owner 项目 = full"；匿名 Owner 只对自己（即匿名本人）`full` |
| `views.ts:167 deniesAsAbsent` | 语义不变：匿名被拒 → **404 不是 403**（存在性不泄露，F5.5）；登录者被拒 → 403 |
| `views.ts:216 projectIndex` | 过滤条件改为 `owner_id = 我` ∪ `granted` ∪ `listed`；排序把**官方演示项目置顶**，其余按 `last_sync_at`；**别人的 listed 不进列表**（D1） |
| 所有写面（`/commands/*`、`/projects`、PATCH、DELETE） | 一律要求**有效会话**（否则 401 `login_required`）**且** `owner_id = 我`（否则 404，不泄露存在性） |
| `step-driver.ts:115 canDrive` | 现状"自己的项目，或匿名演示项目"→ 收紧为"**只有 owner 能驱动**"（含演示项目，D2），防止陌生人烧 LLM token |

**列表隔离的直接效果**（对应用户原话"登录了只能看到自己的内容"）：

- 未登录：列表只有官方演示（L2）；直链能打开任何 `listed` 项目（L2 降级投影，无状态/成本/事件摘要）
- 已登录：列表 = 自己的项目（full）+ 官方演示；别人的项目既不显示，直链也 403/404

### 4.5 官方演示项目

- `proj-8f6c57e4-56e` 保持 `visibility='listed'`，侧栏"演示项目"直链保留
- 访客可看（L2），**不可驱动**（D2）；需要跑给评委看时用 Owner 账号驱动
- QA 残留项目（§11 遗留清单）在权限收口后自动从他人列表消失，无需删数据

---

## 5. 方案 B：项目 CRUD

### 5.1 目标形态

| 动作 | 接口 | 权限 | 生效时间 |
| --- | --- | --- | --- |
| **C** | `POST /projects`（已有，不动） | 登录即可 | 即时 |
| **R** | `GET /views/index`、`GET /views/project`（已有，按 §4.4 收口） | 按可见性 | 即时 |
| **U** | **新增** `PATCH /projects/{external_id}` | 仅 owner | 即时（不再入队） |
| **D** | **新增** `DELETE /projects/{external_id}` | 仅 owner + 确认 | 即时（硬删，NFR-05） |

### 5.2 Update：`PATCH /functions/v1/app/projects/{external_id}`

- **请求体**（字段全部可选，至少一个）：`{title?, question?, strategy?, autonomy?, visibility?}`
- **校验**：复用 `validatePayload` 的 `project_settings` 形状（抽成共享函数，避免两处漂移）：
  - `title` 非空 ≤200
  - `question` 沿用 704587e 的 `optionalText()`：空串/纯空白 = 清空（`null`），凭据形状/超长仍 400
  - `strategy` ∈ {starter, standard, research}；`autonomy` ∈ {guided, autonomous, review-only}
  - `visibility` ∈ {private, link, listed}；`→ listed` 前端必须二次确认（Q1 三档）
  - 一个字段都没给 → 400 `invalid_input:empty_patch`
- **写入**：单条 `UPDATE cloud_project SET ... WHERE id = ? AND owner_id = ?`（CAS 语义：`owner_id` 写进 WHERE，越权更新影响行数为 0 → 404）
- **审计**：同时插一行 `cloud_command`（`type=project_settings, status=succeeded, created_by=我, payload=变更摘要`）→ 审计台账不再出现"永远 queued"的假动作
- **响应**：`{ok, project: {...}}`，前端 `invalidateQueries(['project'])` + `['index']`

### 5.3 Delete：`DELETE /functions/v1/app/projects/{external_id}`（硬删 + 级联）

**权限与确认**：

1. 无会话 → 401；有会话但非 owner → **404**（存在性不泄露，与读侧同一条理由）
2. 必须带 `?confirm=<项目标题>`，与库中 `title` 完全一致，否则 400 `invalid_input:confirm` —— 防手滑、防脚本误删（前端弹窗要求输入项目名）
3. 幂等：项目已不存在 → 200 `{ok, deleted: false}`（重复调用不报错，便于失败重入）

**删除顺序**（32 张表中挂 project/run 的 28 张；FK **没有** `ON DELETE CASCADE`，必须子前父后）：

```
① run 的子表（按 run_id）：
   cloud_task_lease → cloud_task → cloud_run_event → cloud_stage_progress
   → cloud_research_node → cloud_metric_result → cloud_evidence_ref
   → cloud_artifact_ref → cloud_experiment → cloud_protocol → cloud_comparison
   → cloud_idea → cloud_ideation_round → cloud_paper_card → cloud_claim
   → cloud_approval_intent → cloud_approval_request
   → cloud_cost_entry → cloud_egress_entry → cloud_sync_batch
② project 的子表（按 project_id，①完成后）：
   live_outbox → cloud_command → cloud_git_state → cloud_file_node
   → cloud_grant → cloud_share_token → cloud_publication → cloud_agent
③ cloud_run
④ cloud_project
```

**实现要点**：

- 逐表 `DELETE ... WHERE run_id/project_id = ?`（managed SDK 单语句，不依赖多语句事务）
- **每一步都幂等**：任一步失败返回 500 并带上"已完成到第 N 步"，前端可重试，重入继续删剩余表——这是"无事务"约束下唯一安全的做法
- 不删 `cloud_owner`（账号还活着）、不删别的项目的行（`WHERE` 严格带 id）
- 删除成功后向 `live_outbox` 推一帧 `revoked`，已打开该页面的浏览器立刻切占位态（复用现有 `LiveFrame.revoked`）

**备选（不推荐）**：`archived_at` 软删。理由：NFR-05 要求"删除后所有读接口 404"且是"被遗忘路径"，软删把用户数据留在库里，与诉求相反；列表过滤也早就做过（`projectIndex` 已滤 `archived_at`），等于什么都没解决。

### 5.4 命令队列的去留（范围控制）

- `project_settings` / `project_archive`：**从 `COMMAND_TYPES` 移除**，前端不再调用（U/D 走新 REST）；台账里历史行保留只读
- `project_create`：保留（已是云端真执行）
- `run_start` / `run_pause` / `git_*` / `file_*` 等 **local-agent 时代的死类型**：本次**不动**，只在文档标注"待清理"——一次 PR 同时动鉴权、CRUD、清理三件事，回归面太大（D5）

### 5.5 前端改动清单

| 位置 | 改动 |
| --- | --- |
| 路由 | 新增 `#/login`、`#/register`；`/console` 与 `#/p/*` 加守卫：`/auth/me` 401 → 重定向 `#/login`（带 `return` 参数） |
| `AuthPanel` | 登录/注册同一张表单切换；错误文案区分"用户名已存在 / 账号或密码错误 / 账号已锁定（15 分钟后重试）" |
| 顶栏 | 显示当前用户名 + "退出登录"（调 `/auth/logout`，清本地状态，回 `#/login`） |
| `api.ts` | `credentials: 'same-origin'` 已有（Cookie 自动带）；`login_required` 文案改"请先登录"；`loginHref` 的平台登录链接删除 |
| 项目列表 | 每行加操作列：**重命名**（行内编辑 → PATCH）、**删除**（确认弹窗输入项目名 → DELETE）；列表空态文案改为"还没有你的项目，点右上角新建" |
| 设置页 | 保存按钮改走 PATCH（成功提示"已保存"，失败显示真实原因，**不再出现"已提交"但没变化**）；底部加"删除项目"危险区 |
| `live.ts` | WS 同源自动带 Cookie（M0 验证）；若降级方案触发则带 `?session=` |
| 演示链接 | 侧栏"演示项目"保留；未登录时点击进 L2 只读页 |

### 5.6 验收用例（线上逐条点）

1. 匿名打开站点 → 列表只见演示项目；直接访问别人的私有项目 URL → "云端没有这个对象"
2. 注册 `alice` → 列表为空 → 新建项目 A → 列表出现 A
3. 注册 `bob`（新浏览器/无痕）→ 列表**看不到 A**；直接访问 A 的 URL → 404 文案；尝试 `PATCH`/`DELETE` A → 404
4. `alice` 改 A 的标题 → 刷新即变（≤1 s）；审计页出现一条 `succeeded` 的 `project_settings`
5. `alice` 删除 A（输入标题确认）→ 列表消失；`GET /views/project` 404；`GET /views/costs|egress|approvals` 全 404
6. `alice` 登出 → 所有写面 401；重新登录 → 恢复
7. 连续错密码 10 次 → 第 11 次提示"已锁定"，15 分钟内即使密码正确也拒绝

---

## 6. 测试与门禁

| 文件 | 内容 |
| --- | --- |
| 新增 `web/functions/test/auth.test.ts` | 注册成功 / 重复用户名 409 / 弱密码（<8）400 / 登录成功并下发会话 / 错密码 400 且不区分原因 / `failed_attempts` 累加与锁定 / 登出后 401 / `GET /auth/me` / 会话过期与吊销 / 限流窗口 |
| 新增 `web/functions/test/crud.test.ts` | PATCH 生效且落审计行 / 空 patch 400 / **非 owner PATCH → 404 且 0 行更新** / DELETE 后 project·run·cost·idea 读接口全 404 / confirm 不匹配 400 / 重复 DELETE 幂等 / 删除只影响目标项目 |
| 修复 `access.test.ts` 6 条 | `canRead` 恢复后应**自然转绿**（逐条核对语义，不允许改断言凑绿） |
| 清理 12 条 local-agent 断言 | 断言对象（排队语义、Agent 领取）随子系统已删除 → 删除这些用例并在 commit message 说明理由；**不是**为了让门禁变绿而删校验 |
| 2 条 Node20 WS | 保留，标注环境限制（现有处理方式不变） |
| 目标 | `≥ 90%` 通过，`auth.test.ts` + `crud.test.ts` 全绿；`web/console` `tsc --noEmit` 0 错 |

---

## 7. 分期实施（每期：测试 → 小 commit → push → 部署 → 线上验收）

| 期 | 内容 | 交付判据 |
| --- | --- | --- |
| **M0** | 平台探针：`Set-Cookie`/`Cookie`/WS 带 Cookie 三项实测 | 结论写进本文 §4.3；若失败启用降级路径 |
| **M1** | migration 0007 + `/auth/*` 四个接口 + 会话解析（`resolveViewer` 切到 Cookie） | `auth.test.ts` 全绿；线上 curl 注册→登录→`/auth/me` 200 |
| **M2** | 权限收口：`canRead`/`readLevel`/`projectIndex`/写面 owner 校验 + `canDrive` 收紧 | 6 条 ACL 测试转绿；验收用例 1-3 通过 |
| **M3** | CRUD：`PATCH` + `DELETE`（含级联顺序与幂等）+ 审计行 | `crud.test.ts` 全绿；验收用例 4-5 通过 |
| **M4** | 前端：登录/注册页、路由守卫、顶栏用户态、列表行操作、设置页改 PATCH、删除确认弹窗 | 本地预览走通 7 条验收用例 |
| **M5** | 文档同步（REQUIREMENTS A1/可见性/NFR-05、PROGRESS 记录）+ 线上全量验收 | 本文 §5.6 七条逐条打勾 |

---

## 8. 红线（沿用仓库既有约束，逐条不可妥协）

- **密码与会话 token 明文不进** prompt、事件、日志、artifact、错误栈、测试输出——库里只有哈希，Cookie 里才是明文
- **不为了让测试通过而删除**权限校验、审计、证据校验；删的只能是"断言对象已不存在"的过时用例，且要写明理由
- **删除是不可逆动作**：仅 owner + 标题确认 + 幂等重入，三者缺一不上线
- 不直接推 `main`；每个垂直切片小 commit + push；改前 `fetch` + `rebase`
- 部署前先本地 dev 预览（用户既定偏好）
- 错误响应不回显内部标识（列名、SQL、另一用户是否存在）

---

## 9. 风险与兼容性

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 网关剥 `Set-Cookie` | 会话方案地基塌 | M0 先探；降级路径 §4.3 已写明（短 TTL + query 传输） |
| 既有数据无主 | 改造后老项目谁也登不进去（平台身份/匿名 Owner 没有账号） | 迁移脚本：把 `account_id IS NULL` 的 `cloud_owner` 名下项目，一次性挂到**首个注册账号**（显式执行的 SQL，不自动跑）；或按 D4 归档残留 QA 项目 |
| 演示项目被访客驱动烧 token | 成本不可控 | `canDrive` 收紧为仅 owner（M2） |
| 硬删中途失败 | 半删状态 | 步骤幂等 + 可重入重试；`WHERE` 严格带 id；上线前在 QA 项目上先演练 |
| 开放注册被刷 | 库里垃圾账号 | 用户名唯一 + 注册限流 10/min/IP + 密码上限 128；后续要邮箱验证再议 |
| 12 条过时测试删除被误读 | "为了绿灯删测试" | commit message 逐条列出断言对象已删除的证据（`local-agent/` 目录不存在） |

---

## 10. 决策点（需拍板，不回不动 M2 之后）

| # | 问题 | 我的建议 |
| --- | --- | --- |
| **D1** | 列表要不要显示别人的 `listed` 项目？ | **不显示**。直链仍可读（保留 REQUIREMENTS 的 listed 语义），但列表只放自己的 + 官方演示——同时解决"太乱" |
| **D2** | 演示项目允许访客点"继续运行"吗？ | **不允许**（只读）。跑给评委看时用 Owner 账号，避免陌生人烧 LLM token |
| **D3** | 留不留 Qoder 平台身份当运维后门？ | **不留**。留了就等于没做权限隔离；真需要运维通道再单独加带审计的管理员账号 |
| **D4** | 删除是硬删还是归档软删？ | **硬删**（NFR-05 要求 404 + 被遗忘路径）；残留 QA 项目先归档不删，避免误伤 |
| **D5** | 顺带清理 `run_*`/`git_*` 等 local-agent 死命令类型吗？ | **本次不动**，只清 `project_settings`/`project_archive`（D5 之外的范围控制），死类型单独一个 PR |
