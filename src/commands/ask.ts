import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { interpretInput } from '../cli/nl.js';
import { runCli } from '../cli/runner.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek ask "<text>"` — the single entry for free-text REPL input
 * (ADR-006: the REPL relays here instead of interpreting itself):
 * 1. known queries → answered by the SAME non-interactive CLI use-cases;
 * 2. high-impact requests (budget/priority/protocol/idea/experiments) →
 *    pending-approval Decision, never executed;
 * 3. everything else → routed to the current mode's supervisor (DSH Agent)
 *    which classifies it into one of the two above — "unknown input" never
 *    reaches the user.
 */
const SUPERVISOR_INSTRUCTION = `You are the IdeaSeek research supervisor. Classify the user's message and answer with ONE JSON object only:
{"kind":"query"|"pending-action"|"unclear","answer":"short direct answer or empty string","cliArgs":["command","args"] or null,"reason":"budget|priority|protocol|idea|experiment|other","summary":"the request restated for an audit log"}
Rules: kind=query means a read-only question about status/next/papers/comparisons/ideas/experiments/models — put the equivalent CLI argv in cliArgs and a one-line answer in answer. kind=pending-action means the user wants to CHANGE budget, priority, protocol, ideas or experiments — restate it in summary with a reason. kind=unclear is only for genuinely uninterpretable text. Never claim you executed anything; never include secrets.`;

function parseSupervisorOutput(output: string): {
  kind: string;
  answer?: string;
  cliArgs?: string[];
  reason?: string;
  summary?: string;
} | null {
  try {
    const parsed = JSON.parse(output) as {
      kind?: string;
      answer?: string;
      cliArgs?: string[];
      reason?: string;
      summary?: string;
    };
    if (!parsed || typeof parsed.kind !== 'string') return null;
    return {
      kind: parsed.kind,
      answer: parsed.answer,
      cliArgs: parsed.cliArgs,
      reason: parsed.reason,
      summary: parsed.summary,
    };
  } catch {
    return null;
  }
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask')
    .description(
      'free-text entry: queries answer from state, high-impact requests become pending Decisions, rest routes to the supervisor',
    )
    .argument('<text...>', 'the user message')
    .option(
      '--harness <kind>',
      'supervisor harness for unclassified text: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (text: string[], opts: { harness?: string; json?: boolean }) => {
        const message = text.join(' ').trim();
        if (!message) {
          throw new IdeaseekError('INVALID_ARGUMENT', 'ask requires a message');
        }

        // 1/2: deterministic classification first — no model needed.
        const intent = interpretInput(message);
        if (intent.kind === 'query') {
          const result = await runCli(intent.cliArgs, { timeoutMs: 60_000 });
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                source: 'deterministic-query',
                label: intent.label,
                cliArgs: intent.cliArgs,
              }),
            );
          }
          return result.code;
        }
        if (intent.kind === 'pending-action') {
          const decision = await runCli(
            ['decision', 'propose', `${intent.summary} (classified: ${intent.reason})`],
            { timeoutMs: 60_000 },
          );
          if (decision.stdout) process.stdout.write(decision.stdout);
          if (decision.stderr) process.stderr.write(decision.stderr);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                source: 'deterministic-classifier',
                kind: 'pending-action',
                reason: intent.reason,
                summary: intent.summary,
              }),
            );
          }
          return decision.code;
        }

        // 3: unclassified → supervisor (DSH Agent for the current mode).
        const keyPresent = Boolean(
          process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim(),
        );
        const kind =
          opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
        const { buildHarness } = await import('./shared.js');
        const harness = buildHarness(kind);
        await harness.initialize();
        try {
          const result = await harness.runTask({
            runId: 'ask-session',
            taskId: `ask-${Date.now()}`,
            profile: 'demo',
            instruction: SUPERVISOR_INSTRUCTION,
            inputs: [{ kind: 'text', name: 'user_message', content: message }],
            outputSchema: 'supervisor-intent-v1',
            budget: { timeoutMs: 60_000, maxOutputTokens: 1024 },
            idempotencyKey: `ask:${sha256Of(message)}`,
          });
          const parsed = parseSupervisorOutput(result.output);
          if (!parsed) {
            throw new IdeaseekError(
              'INTERNAL',
              `supervisor returned unparseable output: ${result.output.slice(0, 200)}`,
            );
          }
          if (
            parsed.kind === 'query' &&
            Array.isArray(parsed.cliArgs) &&
            parsed.cliArgs.length > 0
          ) {
            const relayed = await runCli(parsed.cliArgs, { timeoutMs: 60_000 });
            if (relayed.stdout) process.stdout.write(relayed.stdout);
            if (relayed.stderr) process.stderr.write(relayed.stderr);
            if (opts.json) {
              process.stdout.write(
                jsonLine({ source: 'supervisor', kind: 'query', answer: parsed.answer ?? null }),
              );
            }
            return relayed.code;
          }
          if (parsed.kind === 'pending-action') {
            const summary = parsed.summary || message;
            const decision = await runCli(
              [
                'decision',
                'propose',
                `${summary} (classified by supervisor: ${parsed.reason ?? 'other'})`,
              ],
              { timeoutMs: 60_000 },
            );
            if (decision.stdout) process.stdout.write(decision.stdout);
            if (decision.stderr) process.stderr.write(decision.stderr);
            if (opts.json) {
              process.stdout.write(
                jsonLine({ ...parsed, source: 'supervisor', kind: 'pending-action' }),
              );
            }
            return decision.code;
          }
          // unclear: surface the supervisor's short answer, never "unknown input".
          if (opts.json) {
            process.stdout.write(jsonLine({ source: 'supervisor', ...parsed }));
            return 0;
          }
          if (parsed.answer) process.stdout.write(`${parsed.answer}\n`);
          process.stdout.write(
            'rephrase, or use /help for commands · high-impact requests become pending-approval Decisions\n',
          );
          return 0;
        } catch (error) {
          const message2 = error instanceof Error ? error.message : String(error);
          const block =
            error instanceof Error && error.name === 'HarnessBlockError'
              ? ` [${(error as { block?: string }).block ?? 'BLOCKED'}]`
              : '';
          if (opts.json) {
            process.stdout.write(
              jsonLine({ source: 'supervisor', error: message2, kind: 'unavailable' }),
            );
          } else {
            process.stderr.write(
              `supervisor unavailable (${kind})${block}: ${message2}\n` +
                'try /help, rephrase, or run a keyed task to verify credentials\n',
            );
          }
          return 2;
        } finally {
          await harness.shutdown().catch(() => undefined);
        }
      }),
    );
}
