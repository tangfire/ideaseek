-- Phase 5/6: 本地 Agent 上报的仓库状态与文件清单
--
-- 语法约束同 0003（受管子集：`app.` schema、无 IF NOT EXISTS、无 CHECK、索引只写
-- 普通列、单份 plan ≤20 条；提交时去注释）。
--
-- 这两张表是**投影之外的第二写入通道**，必须说清楚它凭什么存在：
-- 0001 头注要求"唯一写入者是 ingest 路由"，针对的是 cloud_* 投影表——那部分不变量
-- 原样保留，本文件两张表都不是投影，删掉它们不影响 workflow.sqlite 重建。写入主体
-- 是本地 Agent 的 sync token（scope=commands），浏览器拿不到任何写路径；这也是
-- commands.ts 里所有读端口都过 `full` 判定的原因。
--
-- 文件清单只存路径、大小、类型与哈希，**不存内容**（0001 不变量 3：无正文）。
-- 论文文件名本身可能泄露研究方向，所以列在 L1：匿名与 share 链接一律读不到。

CREATE TABLE app.cloud_git_state (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL UNIQUE REFERENCES app.cloud_project(id),
  branch            text,
  ahead             integer,
  behind            integer,
  staged            integer,
  unstaged          integer,
  untracked         integer,
  last_commit_hash  text,
  last_commit_at    timestamptz,
  last_commit_text  text,
  dirty             boolean,
  reported_at       timestamptz NOT NULL
);

CREATE TABLE app.cloud_file_node (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES app.cloud_project(id),
  path        text NOT NULL,
  kind        text NOT NULL,
  size        bigint,
  mime_type   text,
  updated_at  timestamptz,
  reported_at timestamptz NOT NULL,
  UNIQUE (project_id, path)
);

CREATE INDEX idx_file_node_project ON app.cloud_file_node (project_id, path);
