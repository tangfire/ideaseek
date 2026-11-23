CREATE TABLE app.cloud_task_lease (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL UNIQUE,
  worker_id     text NOT NULL,
  lease_epoch   integer NOT NULL,
  leased_at     timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL
);

CREATE INDEX idx_task_lease_expires ON app.cloud_task_lease (expires_at);

CREATE TABLE app.cloud_research_node (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES app.cloud_run(id),
  node_id       text NOT NULL,
  kind          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  title         text,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, node_id)
);
