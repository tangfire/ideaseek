import { probeCapacity, type CapacityProbe } from './capacity.js';
import { detectWatchdog } from './watchdog.js';
import { readLatestBackup } from './backup.js';

/**
 * Runtime resource alerts (Phase 7 stale-heartbeat / 磁盘阈值 / 备份失败 /
 * 额度告警): ONE aggregation adapter over facts that already exist —
 * capacity probe measurements, the durable backup log, the latest run's
 * quota state and watchdog liveness findings.
 *
 * Contract (LONG_RUNNING + Phase 7 验收): alerts REPORT FACTS ONLY —
 * measurements, states and timestamps — and never judge idea validity,
 * hypothesis outcomes or scientific results. The adapter is read-only: it
 * never writes to the run, task, event or research-node systems, so an
 * alert can never mutate workflow state. Budget-usage alerts need cost
 * telemetry that does not exist yet; quota exhaustion is reported instead
 * (the fact we can actually measure).
 */

export type AlertKind =
  | 'disk-threshold'
  | 'backup-failed'
  | 'quota-exhausted'
  | 'worker-stale'
  | 'supervisor-dead'
  | 'lock-stale'
  | 'experiment-stalled';

export interface RuntimeAlert {
  kind: AlertKind;
  /** Operational urgency only (when a human should look), never scientific. */
  severity: 'warning' | 'critical';
  /** One factual sentence with the measurement or state spelled out. */
  detail: string;
  /** Structured machine-readable facts (numbers/status/timestamps). */
  facts: Record<string, string | number | boolean | null>;
}

export interface AlertsReport {
  checkedAt: number;
  healthy: boolean;
  alerts: RuntimeAlert[];
}

export interface AlertsOptions {
  /** Injected time for deterministic reports (accelerated-clock soak). */
  now?: number;
  /** Disk floor in GiB — same default as computeAdmission's disk gate. */
  minDiskFreeGiB?: number;
  /** Pre-collected probe (tests inject one; otherwise a live host probe). */
  probe?: CapacityProbe | null;
  /** Set false to skip the watchdog composition (resource alerts only). */
  liveness?: boolean;
}

const WATCHDOG_KIND: Record<string, AlertKind> = {
  worker: 'worker-stale',
  supervisor: 'supervisor-dead',
  lock: 'lock-stale',
  experiment: 'experiment-stalled',
};

export async function collectRuntimeAlerts(
  root: string,
  opts: AlertsOptions = {},
): Promise<AlertsReport> {
  const now = opts.now ?? Date.now();
  const alerts: RuntimeAlert[] = [];
  const minDiskFreeGiB = opts.minDiskFreeGiB ?? 5;

  // --- disk floor (same gate that pauses new experiment admission) --------
  const probe = opts.probe !== undefined ? opts.probe : await probeCapacity(root).catch(() => null);
  if (
    probe &&
    probe.diskFreeGiB !== null &&
    Number.isFinite(probe.diskFreeGiB) &&
    probe.diskFreeGiB < minDiskFreeGiB
  ) {
    alerts.push({
      kind: 'disk-threshold',
      severity: 'warning',
      detail:
        `disk free ${probe.diskFreeGiB} GiB is below the ${minDiskFreeGiB} GiB floor — ` +
        'new experiment admission is paused until space is freed (fact: admission disk gate)',
      facts: { diskFreeGiB: probe.diskFreeGiB, floorGiB: minDiskFreeGiB },
    });
  }

  // --- latest backup attempt (ok clears; failed alerts) -------------------
  const backup = await readLatestBackup(root);
  if (backup && backup.status === 'failed') {
    alerts.push({
      kind: 'backup-failed',
      severity: 'critical',
      detail: `latest project backup at ${backup.at} failed: ${backup.error ?? 'unknown error'}`,
      facts: { at: backup.at, status: backup.status, error: backup.error },
    });
  }

  // --- quota state of the latest run (budget-family fact) -----------------
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (run && run.status === 'QUOTA_EXHAUSTED') {
      alerts.push({
        kind: 'quota-exhausted',
        severity: 'critical',
        detail:
          `run ${run.runId} is QUOTA_EXHAUSTED` +
          `${run.blockReason ? `: ${run.blockReason}` : ''} — ` +
          'no new model tasks will be claimed until `ideaseek continue` (fact: run status)',
        facts: {
          runId: run.runId,
          status: run.status,
          blockReason: run.blockReason ?? null,
        },
      });
    }
  } finally {
    await runtime.close();
  }

  // --- liveness composition (watchdog stays the single detector) ----------
  if (opts.liveness !== false) {
    const report = await detectWatchdog(root, { now });
    for (const finding of report.findings) {
      const kind = WATCHDOG_KIND[finding.scope];
      if (!kind) continue;
      alerts.push({
        kind,
        severity: finding.state === 'dead' ? 'critical' : 'warning',
        detail: finding.detail,
        facts: {
          scope: finding.scope,
          target: finding.target,
          state: finding.state,
        },
      });
    }
  }

  alerts.sort((a, b) => a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail));
  return { checkedAt: now, healthy: alerts.length === 0, alerts };
}
