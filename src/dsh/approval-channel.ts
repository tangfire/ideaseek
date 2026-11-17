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

/**
 * The one human approval prompter, for whichever command needs it.
 *
 * Extracted because `idea implement` ran for four agent rounds without it: the
 * command passed `policy: 'interactive'` on the strength of a TTY and never
 * attached a prompt function, so every tool call was refused silently and the
 * session ended with the agent reporting that nothing it wrote could be
 * executed. "Interactive" is a property of the wiring, not of the terminal, and
 * a single implementation means the commands cannot drift into disagreeing about
 * what asking a person looks like.
 */
export async function askForApprovalOnce(
  request: ApprovalRequest,
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
): Promise<boolean> {
  if (process.env.IDEASEEK_AGENT_APPROVAL === 'stdio') {
    write(encodeApprovalRequest(request));
    return (await readStdinLine()) === APPROVAL_ALLOW;
  }
  if (process.stdin.isTTY !== true) return false;
  write(
    `agent requests tool approval: ${request.toolName}` +
      `${request.reason ? ` — ${request.reason}` : ''}\n`,
  );
  write('allow ONCE? [y/N] ');
  const answer = (await readStdinLine()).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/** One trimmed line from stdin; '' when the input is not interactive or ended. */
export function readStdinLine(): Promise<string> {
  return import('node:readline').then(
    (readline) =>
      new Promise<string>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin });
        rl.question('', (line) => {
          rl.close();
          resolve(line.trim());
        });
        // A closed stdin (piped input that ran out) must answer something, or
        // the agent turn would hang forever on a question nobody can hear.
        rl.on('close', () => resolve(''));
      }),
  );
}
