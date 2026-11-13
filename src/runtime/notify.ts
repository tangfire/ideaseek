import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * User notifications (Phase 7 通知入口): enabled/disabled and the webhook
 * come from the USER config (~/.ideaseek/config.yaml or
 * IDEASEEK_USER_CONFIG — never the project file, never secrets). Every
 * enabled notification is first recorded durably in
 * `.research/notifications.jsonl` (local delivery record), then POSTed to
 * the webhook when configured. Delivery never throws into the caller —
 * a failed webhook is a recorded failure, not a crashed run.
 */

export interface NotificationRecord {
  ts: number;
  kind: string;
  title: string;
  summary: string;
  project: string;
  /** 'recorded' = local only; webhook result noted after the attempt. */
  delivery: 'recorded' | 'webhook-ok' | 'webhook-failed';
  webhookDetail?: string;
}

export interface NotifyResult {
  sent: boolean;
  reason: string;
  record: NotificationRecord | null;
}

function notificationsPath(root: string): string {
  return join(root, '.research', 'notifications.jsonl');
}

export async function notifyUser(
  root: string,
  event: { kind: string; title: string; summary: string },
): Promise<NotifyResult> {
  const { loadUserConfig } = await import('../config/user-config.js');
  const user = await loadUserConfig();
  const config = user.config.notifications;
  if (!config.enabled) return { sent: false, reason: 'disabled', record: null };

  const projectName = await (async () => {
    try {
      const { loadConfig } = await import('../config/config.js');
      const { projectPaths } = await import('../config/paths.js');
      return (await loadConfig(projectPaths(root))).resolved.project.name;
    } catch {
      return root;
    }
  })();

  const record: NotificationRecord = {
    ts: Date.now(),
    kind: event.kind,
    title: event.title,
    summary: event.summary,
    project: projectName,
    delivery: 'recorded',
  };

  // Durable local record FIRST (webhook outcome is appended after).
  await mkdir(join(root, '.research'), { recursive: true });
  const path = notificationsPath(root);
  await appendFile(path, `${JSON.stringify({ ...record })}\n`, 'utf8');

  if (!config.webhook) {
    return { sent: true, reason: 'recorded', record };
  }

  try {
    const response = await fetch(config.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: record.title,
        text: record.summary,
        kind: record.kind,
        project: record.project,
        ts: record.ts,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    record.delivery = 'webhook-ok';
    await appendFile(path, `${JSON.stringify({ ...record })}\n`, 'utf8');
    return { sent: true, reason: 'webhook-ok', record };
  } catch (error) {
    record.delivery = 'webhook-failed';
    record.webhookDetail = (error as Error).message.slice(0, 200);
    await appendFile(path, `${JSON.stringify({ ...record })}\n`, 'utf8');
    return { sent: true, reason: `webhook-failed: ${record.webhookDetail}`, record };
  }
}

/** Last N local notification records (newest first). */
/**
 * Cooldown for recurring alert notifications (PROGRESS 213): the same
 * alert kind re-notifies only after `cooldownMs` - a stuck disk must not
 * spam the webhook every supervisor heartbeat.
 */
export function shouldNotifyAlert(
  records: Pick<NotificationRecord, 'kind' | 'ts'>[],
  notifyKind: string,
  now: number,
  cooldownMs = 30 * 60_000,
): boolean {
  return !records.some((record) => record.kind === notifyKind && now - record.ts < cooldownMs);
}

export async function listNotifications(root: string, limit = 10): Promise<NotificationRecord[]> {
  try {
    const raw = await readFile(notificationsPath(root), 'utf8');
    const records = raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as NotificationRecord);
    return records.slice(-limit).reverse();
  } catch {
    return [];
  }
}
