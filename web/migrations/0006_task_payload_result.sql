-- 引擎任务需要携带输入与结果：cloud_task 建表时（0001）没有这两列，
-- 云端 enqueueTask/commitTask 写入即 400，阶段被静默跳过（2026-11-23 线上实测）。
-- 可空、无默认：expand 阶段，旧代码不受影响。
ALTER TABLE app.cloud_task ADD COLUMN payload jsonb;
ALTER TABLE app.cloud_task ADD COLUMN result jsonb;