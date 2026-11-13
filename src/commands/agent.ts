import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek agent` — Agent mode against a REAL DSH coding session
 * (docs/ARCHITECTURE research-cli; no fixed greetings, no ask-supervisor
 * stand-in): one prompt → pinned DSH runtime → named/resumable session
 * with the project as cwd; tool approvals are operator-driven on a TTY
 * and default to rejected everywhere else. Each turn records an audited
 * Decision/Event (truncated, redacted) and the session id for --resume.
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

          const { agentSessionsPath, recordAgentSession } = await import('../agent/dsh-session.js');

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

          const { runAgentTurn, redactAgentText } = await import('../agent/dsh-session.js');
          const result = await runAgentTurn({
            cwd: root,
            prompt,
            ...(opts.resume ? { sessionId: opts.resume } : {}),
            policy: opts.denyTools ? 'deny' : 'interactive',
            ...(opts.provider ? { provider: opts.provider } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(Number.isFinite(opts.timeout) ? { requestTimeoutMs: opts.timeout as number } : {}),
            onLog: (message) => process.stderr.write(`  · ${message}\n`),
            // Interactive approval on a real TTY; resolveApproval denies
            // everywhere else (never auto-approve, never fake-allow).
            promptFn: async ({ toolName, reason }) => {
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
