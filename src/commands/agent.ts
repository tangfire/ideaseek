import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { APPROVAL_ALLOW, encodeApprovalRequest } from '../dsh/approval-channel.js';
import { action, jsonLine } from './shared.js';

/** Reads one answer line from stdin (stdio approval channel). */
function readStdinAnswer(): Promise<string | null> {
  return import('node:readline').then(
    (readline) =>
      new Promise<string | null>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin });
        // Settled guard: rl.close() emits 'close' SYNCHRONOUSLY, so a bare
        // resolve-after-close ordering lets the EOF handler win the race
        // and every 'allow' answer got judged as a rejection.
        let settled = false;
        rl.once('line', (line) => {
          if (settled) return;
          settled = true;
          resolve(line.trim().toLowerCase());
          rl.close();
        });
        // TUI quit / closed pipe: deny rather than hang the turn.
        rl.once('close', () => {
          if (settled) return;
          settled = true;
          resolve(null);
        });
      }),
  );
}

/** Canned agent turn for tests (IDEASEEK_FAKE_AGENT_TURN=1). */
async function runFakeAgentTurn(prompt: string, json: boolean): Promise<number> {
  process.stderr.write('  · dsh runtime started\n');
  process.stderr.write('  · new session session-fake-e2e\n');
  let allowed = false;
  let approval: { toolName: string; reason: string } | null = null;
  // Mirror the real step stream: tool/call → approval → tool/result.
  process.stderr.write('  ⚙ pwsh {"command":"ls"}\n');
  if (process.env.IDEASEEK_AGENT_APPROVAL === 'stdio') {
    approval = { toolName: 'pwsh', reason: `workspace probe for: ${prompt.slice(0, 60)}` };
    process.stdout.write(encodeApprovalRequest(approval));
    allowed = (await readStdinAnswer()) === APPROVAL_ALLOW;
    process.stderr.write(
      `  · approval ${allowed ? 'allowed-once' : 'rejected'}: ${approval.toolName}\n`,
    );
  }
  process.stderr.write(allowed ? '  ⚙ ✓ pwsh\n' : '  ⚙ ✗ pwsh — approval denied\n');
  const response = allowed
    ? 'Fake turn complete — the tool ran and the answer is grounded.'
    : 'Understood — the approval was rejected; standing by without the tool.';
  if (json) {
    process.stdout.write(
      jsonLine({
        sessionId: 'session-fake-e2e',
        resumed: false,
        finishReason: 'completed',
        eventCount: 3,
        approvals: approval
          ? [{ outcome: allowed ? 'allowed-once' : 'rejected', toolName: approval.toolName }]
          : [],
        response,
        eventSeq: null,
      }),
    );
    return 0;
  }
  process.stdout.write(
    'agent turn → session session-fake-e2e (new, finish=completed, 3 event(s))\n',
  );
  if (approval) {
    process.stdout.write(
      `  approval ${allowed ? 'allowed-once' : 'rejected'}: ${approval.toolName}\n`,
    );
  }
  process.stdout.write(`  ${response}\n`);
  process.stdout.write('next: ideaseek agent "<prompt>" --resume session-fake-e2e\n');
  return 0;
}

/**
 * `ideaseek agent` — Agent mode against a REAL DSH coding session
 * (docs/ARCHITECTURE research-cli; no fixed greetings, no ask-supervisor
 * stand-in): one prompt → pinned DSH runtime → named/resumable session
 * with the project as cwd; tool approvals are operator-driven on a TTY,
 * via the parent shell's stdio channel, and default to rejected
 * everywhere else. Each turn records an audited Decision/Event
 * (truncated, redacted) and the session id for --resume.
 */
export function registerAgentCommand(program: Command): void {
  program
    .command('agent')
    .description(
      'run one real DSH coding-session turn in the project (approvals: TTY prompt, else rejected)',
    )
    .argument('[prompt]', 'the instruction for this turn (omit with --list/--resume-only)')
    .option('--resume <sessionId>', 'continue a persisted session instead of minting a new one')
    .option('--list', 'list known session ids and exit')
    .option('--deny-tools', 'reject every tool approval for this turn (safe default on scripts)')
    .option('--provider <id>', 'DSH provider route for the session')
    .option('--model <name>', 'model for the session')
    .option(
      '--timeout <ms>',
      'per-request bound (a coding turn can legitimately run long)',
      (value) => Number(value),
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          prompt: string | undefined,
          opts: {
            resume?: string;
            list?: boolean;
            denyTools?: boolean;
            provider?: string;
            model?: string;
            timeout?: number;
            json?: boolean;
          },
        ) => {
          const { findProjectRoot } = await import('../config/paths.js');
          const root = await findProjectRoot(process.cwd());
          if (!root) {
            throw new IdeaseekError(
              'NOT_INITIALIZED',
              'no IdeaSeek project here — agent sessions run inside a project (ideaseek init)',
            );
          }

          const { agentSessionsPath, recordAgentSession } = await import('../dsh/session.js');

          if (opts.list) {
            const { readFile } = await import('node:fs/promises');
            let sessions: { sessionId: string; updatedAt: number; promptHead: string }[] = [];
            try {
              const registry = JSON.parse(await readFile(agentSessionsPath(root), 'utf8')) as {
                sessions: typeof sessions;
              };
              sessions = registry.sessions ?? [];
            } catch {
              sessions = [];
            }
            if (opts.json) {
              process.stdout.write(jsonLine({ sessions }));
              return 0;
            }
            if (sessions.length === 0) {
              process.stdout.write('no agent sessions yet — ideaseek agent "<prompt>"\n');
              return 0;
            }
            process.stdout.write(`${sessions.length} agent session(s):\n`);
            for (const session of sessions) {
              process.stdout.write(
                `  ${session.sessionId}  ${new Date(session.updatedAt).toISOString()}  ${session.promptHead}\n`,
              );
            }
            return 0;
          }

          if (!prompt || !prompt.trim()) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              'agent needs a prompt (or --list / --resume <sessionId> with a prompt)',
            );
          }

          // Test hook: a canned turn that exercises the approval channel
          // without DSH or a model (never spends credentials; human and
          // --json shapes mirror the real summary). TUI e2e drives y/n
          // through it via IDEASEEK_AGENT_APPROVAL=stdio.
          if (process.env.IDEASEEK_FAKE_AGENT_TURN === '1') {
            return await runFakeAgentTurn(prompt, opts.json === true);
          }

          const { runAgentTurn, redactAgentText } = await import('../dsh/session.js');
          const result = await runAgentTurn({
            cwd: root,
            prompt,
            ...(opts.resume ? { sessionId: opts.resume } : {}),
            policy: opts.denyTools ? 'deny' : 'interactive',
            ...(opts.provider ? { provider: opts.provider } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(Number.isFinite(opts.timeout) ? { requestTimeoutMs: opts.timeout as number } : {}),
            onLog: (message) => process.stderr.write(`  · ${message}\n`),
            // Step-level transcript lines (tool/call, tool/result, usage) —
            // stderr rides the TUI's dim streamer, not the red error path.
            onStep: (line) => process.stderr.write(`${line}\n`),
            // Interactive approval on a real TTY, or the parent shell's
            // stdio channel (magic request line + stdin answer); every
            // other pipe context denies (never auto-approve).
            promptFn: async ({ toolName, reason }) => {
              if (process.env.IDEASEEK_AGENT_APPROVAL === 'stdio') {
                process.stdout.write(encodeApprovalRequest({ toolName, reason: reason ?? '' }));
                return (await readStdinAnswer()) === APPROVAL_ALLOW;
              }
              if (!process.stdin.isTTY) return false;
              process.stdout.write(
                `agent requests tool approval: ${toolName}${reason ? ` — ${reason}` : ''}\n`,
              );
              process.stdout.write('allow ONCE? [y/N] ');
              const readline = await import('node:readline');
              const answer = await new Promise<string>((resolve) => {
                const rl = readline.createInterface({
                  input: process.stdin,
                  output: process.stdout,
                });
                rl.question('', (line) => {
                  rl.close();
                  resolve(line.trim().toLowerCase());
                });
              });
              return answer === 'y' || answer === 'yes';
            },
          });

          await recordAgentSession(root, {
            sessionId: result.sessionId,
            prompt,
          });

          // Audited turn: truncated + redacted, never the key material.
          let eventSeq: number | null = null;
          const { ProjectRuntime } = await import('../workflow/runtime.js');
          const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
          try {
            const run = await runtime.db.getLatestRun(runtime.project.id);
            if (run) {
              const event = await runtime.db.appendEvent({
                runId: run.runId,
                phase: 'DECISION',
                objectId: result.sessionId,
                role: 'system',
                eventType: 'agent_turn',
                summary:
                  `agent turn on session ${result.sessionId} ` +
                  `(${result.resumed ? 'resumed' : 'new'}, ${result.eventCount} event(s), ` +
                  `${result.approvals.length} approval(s)): ` +
                  redactAgentText(prompt).slice(0, 160),
                status: result.finishReason ?? 'completed',
              });
              eventSeq = event.seq;
            }
          } finally {
            await runtime.close();
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                sessionId: result.sessionId,
                resumed: result.resumed,
                finishReason: result.finishReason,
                eventCount: result.eventCount,
                approvals: result.approvals,
                response: result.finalResponse,
                eventSeq,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `agent turn → session ${result.sessionId} (${result.resumed ? 'resumed' : 'new'}, ` +
              `finish=${result.finishReason ?? 'unknown'}, ${result.eventCount} event(s))\n`,
          );
          for (const approval of result.approvals) {
            process.stdout.write(`  approval ${approval.outcome}: ${approval.toolName}\n`);
          }
          process.stdout.write(`  ${result.finalResponse.replace(/\n/g, '\n  ')}\n`);
          if (eventSeq !== null) {
            process.stdout.write(`  event #${eventSeq} recorded\n`);
          }
          process.stdout.write(`next: ideaseek agent "<prompt>" --resume ${result.sessionId}\n`);
          return 0;
        },
      ),
    );
}
