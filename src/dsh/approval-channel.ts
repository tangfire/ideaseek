/**
 * Stdio approval channel between the interactive shell and an
 * `ideaseek agent` child (docs/TERMINAL_UX 审批界面). The child emits
 * one magic-prefixed JSON line per tool-approval request on stdout and
 * blocks on a plain stdin line (`allow` / `reject`) for the answer;
 * everything else on stdout stays human-readable agent output.
 *
 * Pure encode/parse — no SDK imports, safe for both the command layer
 * (src/commands/agent.ts) and the TUI session (src/cli/shell).
 */

export const APPROVAL_REQUEST_PREFIX = '__ideaseek_approval__';
export const APPROVAL_ALLOW = 'allow';
export const APPROVAL_REJECT = 'reject';

export interface ApprovalRequest {
  toolName: string;
  reason: string;
}

/** One stdout line carrying an approval request. */
export function encodeApprovalRequest(request: ApprovalRequest): string {
  return `${APPROVAL_REQUEST_PREFIX}${JSON.stringify(request)}\n`;
}

/** Parses a streamed stdout line; null when it is ordinary output. */
export function parseApprovalRequest(line: string): ApprovalRequest | null {
  if (!line.startsWith(APPROVAL_REQUEST_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(APPROVAL_REQUEST_PREFIX.length)) as {
      toolName?: unknown;
      reason?: unknown;
    };
    if (typeof parsed.toolName !== 'string' || parsed.toolName.length === 0) return null;
    return {
      toolName: parsed.toolName,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return null;
  }
}
