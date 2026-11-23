-- Phase 2/4: 命令队列 + 本地 Agent 在线状态
--
-- 受管迁移子集（SPIKE_SITES_RUNTIME.md、0001 头注）：`app.` schema、没有
-- IF NOT EXISTS、类型限 boolean/integer/bigint/text/uuid/timestamptz/jsonb、
-- 约束限 NULL/NOT NULL/PRIMARY KEY/UNIQUE/REFERENCES、索引只写普通列（无 DESC、
-- 无 WHERE）、单份 plan 语句数 ≤20。**提交时去掉注释**，本文件注释是给人读的。
--
-- 为什么命令落在新表而不是 cloud_run：cloud_* 是**只读投影**，可以整体删除后从本地
-- workflow.sqlite 重建（0001 不变量 1）。命令是反向通道——重建投影不可能把用户点过
-- 的按钮一起重建出来，所以它必须有自己的表，并且明确不参与投影重建。
--
-- external_command_id 是幂等键（NFR-06）：Web 侧生成，重试同一个请求不会排第二个
-- 命令。没有它，一次前端超时重试就是两次 `ideaseek run`——那是真金白银的成本。

CREATE TABLE app.cloud_command (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid REFERENCES app.cloud_project(id),
  external_command_id  text NOT NULL UNIQUE,
  type                 text NOT NULL,
  payload              jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'queued',
  created_by           uuid NOT NULL REFERENCES app.cloud_owner(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  claimed_at           timestamptz,
  heartbeat_at         timestamptz,
  finished_at          timestamptz,
  result               jsonb,
  error                text
);

CREATE INDEX idx_command_project ON app.cloud_command (project_id, created_at);

-- queued/claimed/running 的领取扫描走这里；没有部分索引，"只取未终态"由 Function
-- 的 WHERE 加应用侧过滤承担。
CREATE INDEX idx_command_status ON app.cloud_command (status);

-- 在线的是**机器**不是项目：项目可能还没在本地创建（project_create 命令就没有
-- project_id），但机器是可达的。local_projects 是 Agent 自报的目录清单，Web 用它
-- 判断"这个项目在本机有没有对应目录"，只在全权限视图里出示（文件名可能泄露研究方向）。
CREATE TABLE app.cloud_agent (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL UNIQUE REFERENCES app.cloud_owner(id),
  agent_version    text,
  local_projects   jsonb,
  last_seen_at     timestamptz NOT NULL,
  active_commands  integer NOT NULL DEFAULT 0
);
