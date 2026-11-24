-- 自有账号体系（AUTH_AND_CRUD_REFACTOR_PLAN.md §4.1）：
-- 平台网关身份退出业务鉴权，浏览者身份改由本表 + 会话 Cookie 决定。
-- 只加表、加可空列、加索引：旧代码不受影响（沿用 0006 的 expand 纪律）。

-- 账号：用户名唯一（应用侧统一小写后入库），密码只存 PBKDF2 派生值。
-- 唯一性写成列约束而不是 CREATE UNIQUE INDEX：平台的受限 DDL 只收"普通 CREATE INDEX"，
-- 0001-0006 也全是这么表达的（token_hash / external_command_id 同款）。
CREATE TABLE app.cloud_account (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL UNIQUE,
  password_hash   text NOT NULL,          -- 'pbkdf2$<iterations>$<salt_b64>$<hash_b64>'
  display_name    text,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

-- 会话：库里只有哈希，明文只在 Cookie 里（NFR-02 同款纪律）。
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

-- Owner 与账号挂钩：既有 cloud_owner 行（平台身份 / 匿名）保持不动。
-- 不带 REFERENCES：受限 DDL 只允许 ADD COLUMN 可空无默认，外键由 accounts.ts 的
-- 写入顺序保证（先建 account 再建 owner；sessionIdentity 反查 owner）。
-- 不加 UNIQUE：同一账号只会在 register 时建一行 owner，1:1 由应用层维持；
-- 查询永远带 LIMIT 1，即便重复也只会取到一行。
ALTER TABLE app.cloud_owner ADD COLUMN account_id uuid;

CREATE INDEX idx_owner_account ON app.cloud_owner (account_id);
