import { truncateForWidth } from '../cli/slash-menu.js';

/**
 * Pending approvals (docs/TERMINAL_UX 审批界面): a read-only scan of what
 * still needs a user decision — an unlocked protocol proposal, a baseline
 * repair whose code revision needs acceptance, and high-impact
 * natural-language requests recorded as pending-approval Decisions. The
 * REPL renders these as a confirmation block; approving relays the EXISTING
 * non-interactive command (zero duplicated business logic), and decision
 * items are review-only — approving never executes an unreviewed request.
 */

export type PendingKind = 'protocol' | 'decision' | 'repair';

export interface PendingApproval {
  /** Stable identity: protocol:<id>, decision:<seq>, repair:<methodId>. */
  id: string;
  kind: PendingKind;
  summary: string;
  /** Command that performs the approval; null = review-only (decisions). */
  approve: { label: string; cliArgs: string[] } | null;
}

export async function collectPendingApprovals(root: string): Promise<PendingApproval[]> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const items: PendingApproval[] = [];
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    // 1/3: protocol proposal committed but not yet locked.
    const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
    if (artifacts.length > 0) {
      const latest = artifacts[artifacts.length - 1]!;
      try {
        const proposal = JSON.parse(await runtime.store.readFinalText(latest.contentHash)) as {
          protocolId?: unknown;
        };
        const protocolId = typeof proposal.protocolId === 'string' ? proposal.protocolId : null;
        if (protocolId && !(await runtime.db.getProtocolLock(protocolId))) {
          items.push({
            id: `protocol:${protocolId}`,
            kind: 'protocol',
            summary: `lock protocol proposal ${protocolId}`,
            approve: {
              label: 'confirm protocol',
              cliArgs: ['confirm', 'protocol', '--by', 'user'],
            },
          });
        }
      } catch {
        // Unreadable proposal: `confirm protocol` surfaces the real error.
      }
    }

    // 2/3: high-impact requests recorded as pending-approval Decisions.
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (run) {
      const events = await runtime.db.listEvents(run.runId, { limit: 1000 });
      for (const event of events) {
        if (event.eventType !== 'decision' || event.status !== 'pending-approval') continue;
        items.push({
          id: `decision:${event.seq}`,
          kind: 'decision',
          summary: event.summary.replace(/^pending-approval:\s*/, ''),
          approve: null, // review with events; apply via the equivalent command --confirm
        });
      }
    }

    // 3/3: baseline repair passed but the code revision awaits acceptance.
    const comparisons = await runtime.db.listComparisons();
    for (const doc of comparisons) {
      const repair = (doc.record as { repair?: { outcome?: string } }).repair;
      if (repair?.outcome !== 'confirmation-required') continue;
      items.push({
        id: `repair:${doc.methodId}`,
        kind: 'repair',
        summary: `accept code revision from repair of ${doc.methodId}`,
        approve: {
          label: 'accept revision',
          cliArgs: [
            'comparison',
            'set-status',
            doc.methodId,
            'smoke-tested',
            '--reason',
            'user accepted code revision',
          ],
        },
      });
    }
  } finally {
    await runtime.close();
  }
  return items;
}

/**
 * The confirmation block from docs/TERMINAL_UX: box drawing, one row per
 * item and the input hint. Pure and width-aware (narrow terminals truncate).
 */
export function renderApprovalBlock(items: PendingApproval[], columns = 80): string[] {
  const width = Math.max(30, Math.min(columns, 74));
  const inner = width - 4; // between "│ " and " │"
  const pad = (text: string): string => truncateForWidth(text, inner).padEnd(inner);

  const title = '┌─ Confirmation required ';
  const top = `${title}${'─'.repeat(Math.max(0, width - title.length - 1))}┐`;
  const rows = items.map(
    (item, index) => `│ [${index + 1}] ${pad(`${item.kind}  ${item.summary}`)} │`,
  );
  const hint = `│ ${pad('Type a number, /approve [n], or /reject <reason>')} │`;
  const bottom = `└${'─'.repeat(Math.max(0, width - 2))}┘`;
  return [top, ...rows, hint, bottom];
}
