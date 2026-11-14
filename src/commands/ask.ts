import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { interpretInput } from '../cli/nl.js';
import { runCli } from '../cli/runner.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek ask "<text>"` — the single entry for free-text REPL input
 * (ADR-006: the REPL relays here instead of interpreting itself):
 * 1. greetings/capability → instant orientation (no model);
 * 2. known queries → answered by the SAME non-interactive CLI use-cases;
 * 3. high-impact requests (budget/priority/protocol/idea/experiments) →
 *    pending-approval Decision, never executed (even in Analysis mode);
 * 4. Analysis mode material-readiness queries → deterministic assessment;
 * 5. everything else → routed to the mode's read-only DSH agent seeded with
 *    compact project context + recent Q&A history, returning grounded answers,
 *    read-only CLI queries, or pending-approval Decisions.
 */
const SUPERVISOR_INSTRUCTION = `You are the IdeaSeek research supervisor (read-only research tools: project_read, knowledge_search).
Given the project context and user message, respond with ONE JSON object only:
{"kind":"query"|"answer"|"pending-action"|"unclear","answer":"direct grounded answer or short summary","cliArgs":["command","args"] or null,"reason":"budget|priority|protocol|idea|experiment|other","summary":"the request restated for an audit log"}
Rules:
- kind="query": the user wants live workflow/project status that a read-only CLI command prints — put argv in cliArgs (e.g. ["status"], ["next"], ["papers"], ["comparison","list"], ["idea","list"], ["experiment","list"], ["assessment"]) and optionally a one-line summary in answer.
- kind="answer": the user is asking a scientific, paper, dataset, comparison, or reasoning question about the project — use project_context, knowledge_search, or project_read if helpful and write a concise, evidence-grounded answer in "answer" with cliArgs=null. Never invent numbers or citations.
- kind="pending-action": the user wants to CHANGE budget, priority, protocol, comparisons, hypotheses, or experiments — restate the request in "summary" with "reason", cliArgs=null. Never claim you executed anything.
- kind="unclear": only for genuinely uninterpretable text. Never include secrets.`;

const ANALYSIS_ANALYST_INSTRUCTION = `You are the IdeaSeek Analysis Mode Material Analyst (read-only preparation tier; tools: project_read, knowledge_search).
You CANNOT write research code, lock protocols, start experiments, or alter comparisons.
Given the project context (assessment, dataset-card, research-map, comparisons, history) and user message, respond with ONE JSON object only:
{"kind":"answer"|"query"|"pending-action"|"unclear","answer":"direct grounded answer about papers, datasets, comparisons, or material gaps","cliArgs":["command","args"] or null,"reason":"budget|priority|protocol|idea|experiment|other","summary":"the request restated for an audit log"}
Rules:
- Answer questions about existing papers, PaperCards, dataset structure, comparisons, and what materials/preparation steps remain, grounded strictly in observed artifacts (or use knowledge_search / project_read).
- If the user asks for a read-only status view (status, papers, assessment, stale, comparison list), use kind="query" with cliArgs.
- If the user asks to modify budget, priority, protocol, or comparisons, use kind="pending-action".
- Never fabricate results or citations; never include secrets.`;

const MATERIAL_READINESS_RE =
  /\b(missing|gaps?|ready|sufficient|material|materials|prepare|assessment)\b|(缺什么|缺少|还缺|材料|准备好了|够不够|评估)/i;

/**
 * Greetings and capability questions are answered deterministically —
 * instant feedback, zero model cost, and never a cold "rephrase" wall for
 * a user who just said hi (field report: "输入个 hi 啥情况都没发生").
 */
const GREETING =
  /^(hi+|hello+|hey+|yo|hi there|howdy|你好+|您好|在吗|在不在|哈喽|嗨+)[!！.。~～\s]*$/i;
const CAPABILITY = /(你能做什么|你会什么|你能帮我做什么|what can you do)/i;
const ORIENTATION_LINES = [
  'IdeaSeek supervisor ready — /status state · /next next step · /prepare prep · /assessment gaps · /help commands',
  'ask any scientific/status question, or request changes (which become pending-approval Decisions); Alt+C switches to Coding',
];
const UNCLEAR_FALLBACK =
  'not sure how to help — /status · /next · /assessment · /prepare · /help; changes become pending-approval Decisions';

/**
 * Supervisor-supplied argv is NOT trusted verbatim: models often prepend
 * the binary name ("ideaseek status" — relayed as-is this crashed into a
 * raw commander dump), and a misclassified action must never execute:
 * only the read-only query surface may be relayed. Returns the sanitized
 * argv, or null when nothing safe remains to run. Exported for tests.
 */
const READONLY_QUERY_CLI = new Set([
  'status',
  'next',
  'papers',
  'comparison',
  'idea',
  'experiment',
  'models',
  'events',
  'queue',
  'monitor',
  'context',
  'pending',
  'logs',
  'search',
  'explain',
  'projects',
  'rounds',
  'config',
  'doctor',
  'capacity',
  'plan',
  'data',
  'datasets',
  'assessment',
  'stale',
]);

export function sanitizeSupervisorCliArgs(argv: readonly string[]): string[] | null {
  let args = [...argv];
  while (args.length > 0 && /^(ideaseek(\.exe)?|node)$/i.test(args[0]!)) args = args.slice(1);
  if (args.length === 0) return null;
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') return ['--help'];
  if (!READONLY_QUERY_CLI.has(args[0]!)) return null;
  return args;
}

function parseSupervisorOutput(output: string): {
  kind: string;
  answer?: string;
  cliArgs?: string[] | null;
  reason?: string;
  summary?: string;
} | null {
  try {
    const parsed = JSON.parse(output) as {
      kind?: string;
      answer?: string;
      cliArgs?: string[] | null;
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

async function emitAnalysisAssessment(opts: { json?: boolean; note?: string }): Promise<number> {
  const { loadOrBuildAssessment } = await import('../knowledge/assessment.js');
  const { assessment, reused } = await loadOrBuildAssessment(process.cwd());
  const blocking = assessment.gaps.filter((g) => g.priority === 'blocking');
  if (opts.json) {
    process.stdout.write(
      jsonLine({
        source: 'analysis-assessment',
        mode: 'analysis',
        reused,
        verdict: assessment.verdict,
        sufficientFor: assessment.sufficientFor,
        gaps: assessment.gaps,
      }),
    );
  } else {
    if (opts.note) process.stdout.write(`${opts.note}\n`);
    process.stdout.write(
      `analysis mode — research material assessment (${reused ? 'reused' : 'rebuilt'}): ` +
        `${assessment.verdict.toUpperCase()} · protocol design ` +
        `${assessment.sufficientFor.protocolDesign ? 'OK' : 'BLOCKED'} · smoke/quick ` +
        `${assessment.sufficientFor.smokeQuick ? 'OK' : 'BLOCKED'}\n`,
    );
    for (const item of assessment.gaps.slice(0, 12)) {
      process.stdout.write(
        `  [${item.priority}] ${item.id}: ${item.reason}\n` + `          next: ${item.fillIn}\n`,
      );
    }
    if (assessment.gaps.length > 12) {
      process.stdout.write(`  … ${assessment.gaps.length - 12} more in the report\n`);
    }
    process.stdout.write('  file: knowledge/research-material-assessment.json\n');
    process.stdout.write(
      '  (analysis mode: run /prepare to build knowledge artifacts; switch to research when blocking gaps clear)\n',
    );
  }
  return blocking.length > 0 ? 2 : 0;
}

export function registerAskCommand(program: Command): void {
  program
    .command('ask')
    .description(
      'free-text entry: queries answer from state, high-impact requests become pending Decisions, rest routes to the mode-aware read-only agent',
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

        // 0: greetings / capability questions — instant orientation, no
        // model round-trip and never the cold "rephrase" dead end.
        if (GREETING.test(message) || CAPABILITY.test(message)) {
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                source: 'deterministic-greeting',
                kind: 'orientation',
                answer: ORIENTATION_LINES.join(' '),
              }),
            );
          } else {
            for (const line of ORIENTATION_LINES) process.stdout.write(`${line}\n`);
          }
          return 0;
        }

        // 1: deterministic read-only queries — no model needed.
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

        // 2: deterministic high-impact action requests MUST become
        // pending-approval Decisions in BOTH Research and Analysis modes
        // (never silently swallowed by the Analysis gap shortcut).
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

        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd()).catch(() => null);
        const { readSessionMode } = await import('../session/mode.js');
        const sessionMode = root
          ? await readSessionMode(root).catch(() => 'research' as const)
          : ('research' as const);

        const keyPresent = Boolean(
          process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim(),
        );
        const explicitHarness = opts.harness ?? process.env.IDEASEEK_ASK_HARNESS;

        // 3: Analysis mode deterministic readiness path for material/gap
        // questions (or when no model harness is available for deep Q&A).
        if (sessionMode === 'analysis') {
          if (MATERIAL_READINESS_RE.test(message) || (!keyPresent && !explicitHarness)) {
            return emitAnalysisAssessment({
              json: opts.json,
              note:
                !MATERIAL_READINESS_RE.test(message) && !keyPresent && !explicitHarness
                  ? 'analysis mode: no model key set for open-ended Q&A — showing material readiness (/models setup enables Q&A)'
                  : undefined,
            });
          }
        }

        // 4: Model-backed read-only supervisor / material analyst seeded with
        // compact project context + recent Q&A history.
        const kind = explicitHarness ?? (keyPresent ? 'dsh' : 'fake');
        const { buildHarness } = await import('./shared.js');
        const harness = buildHarness(kind);
        // Free text can carry a pasted credential (an API key typed at the
        // prompt instead of `/models setup`). The supervisor call is the one
        // place IdeaSeek sends user text off-machine, so it goes redacted:
        // docs/AGENTS.md forbids secrets in prompts, events and logs.
        const safeMessage = redactSecrets(message);
        const { appendAskHistory, buildAskContext } = await import('../session/ask-context.js');
        const projectContext = root ? await buildAskContext(root, sessionMode) : '';
        const roleLabel = sessionMode === 'analysis' ? 'analyst' : 'supervisor';
        if (!opts.json) process.stdout.write(`${roleLabel} (${kind}): classifying…\n`);
        await harness.initialize();
        try {
          const inputs: { kind: 'text'; name: string; content: string }[] = [
            { kind: 'text', name: 'user_message', content: safeMessage },
          ];
          if (projectContext) {
            inputs.push({ kind: 'text', name: 'project_context', content: projectContext });
          }
          const result = await harness.runTask({
            runId: 'ask-session',
            taskId: `ask-${Date.now()}`,
            profile: 'demo',
            instruction:
              sessionMode === 'analysis' ? ANALYSIS_ANALYST_INSTRUCTION : SUPERVISOR_INSTRUCTION,
            inputs,
            outputSchema: 'supervisor-intent-v1',
            budget: { timeoutMs: 60_000, maxOutputTokens: 1536 },
            idempotencyKey: `ask:${sessionMode}:${sha256Of(safeMessage + projectContext.slice(0, 200))}`,
          });
          const parsed = parseSupervisorOutput(result.output);
          if (!parsed) {
            throw new IdeaseekError(
              'INTERNAL',
              `supervisor returned unparseable output: ${result.output.slice(0, 200)}`,
            );
          }

          const recordTurn = async (turnKind: string, answerText: string) => {
            if (!root) return;
            await appendAskHistory(root, {
              ts: Date.now(),
              mode: sessionMode,
              question: safeMessage,
              kind: turnKind,
              answer: answerText,
            }).catch(() => undefined);
          };

          if (
            parsed.kind === 'query' &&
            Array.isArray(parsed.cliArgs) &&
            parsed.cliArgs.length > 0
          ) {
            const safeArgs = sanitizeSupervisorCliArgs(parsed.cliArgs);
            if (safeArgs) {
              if (!opts.json && parsed.answer?.trim()) {
                process.stdout.write(`${redactSecrets(parsed.answer.trim())}\n`);
              }
              const relayed = await runCli(safeArgs, { timeoutMs: 60_000 });
              if (relayed.stdout) process.stdout.write(relayed.stdout);
              if (relayed.stderr) process.stderr.write(relayed.stderr);
              await recordTurn('query', parsed.answer?.trim() || `ran: ${safeArgs.join(' ')}`);
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    source: sessionMode === 'analysis' ? 'analysis-qa' : 'supervisor',
                    kind: 'query',
                    cliArgs: safeArgs,
                    answer: parsed.answer ?? null,
                  }),
                );
              }
              return relayed.code;
            }
            // Not a read-only query: never relay it — record it for explicit review.
            const decision = await runCli(
              [
                'decision',
                'propose',
                `supervisor suggested (not read-only, not executed): ${parsed.cliArgs.join(' ')}`,
              ],
              { timeoutMs: 60_000 },
            );
            if (decision.stdout) process.stdout.write(decision.stdout);
            if (decision.stderr) process.stderr.write(decision.stderr);
            await recordTurn('refused-non-readonly', parsed.cliArgs.join(' '));
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  source: sessionMode === 'analysis' ? 'analysis-qa' : 'supervisor',
                  kind: 'refused-non-readonly',
                  cliArgs: parsed.cliArgs,
                }),
              );
            }
            return decision.code;
          }

          // Direct evidence-grounded answer (or query with no cliArgs and a real answer).
          if (
            (parsed.kind === 'answer' || parsed.kind === 'query') &&
            typeof parsed.answer === 'string' &&
            parsed.answer.trim().length > 0
          ) {
            const safeAnswer = redactSecrets(parsed.answer.trim());
            await recordTurn('answer', safeAnswer);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  source: sessionMode === 'analysis' ? 'analysis-qa' : 'supervisor-answer',
                  mode: sessionMode,
                  kind: 'answer',
                  answer: safeAnswer,
                }),
              );
            } else {
              process.stdout.write(`${safeAnswer}\n`);
            }
            return 0;
          }

          if (parsed.kind === 'pending-action') {
            const summary = redactSecrets(parsed.summary || safeMessage);
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
            await recordTurn('pending-action', summary);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  ...parsed,
                  summary,
                  source: sessionMode === 'analysis' ? 'analysis-qa' : 'supervisor',
                  kind: 'pending-action',
                }),
              );
            }
            return decision.code;
          }

          // unclear: surface the supervisor's short answer, never "unknown input".
          if (opts.json) {
            process.stdout.write(jsonLine({ source: 'supervisor', ...parsed }));
            return 0;
          }
          if (parsed.answer) process.stdout.write(`${redactSecrets(parsed.answer)}\n`);
          process.stdout.write(`${UNCLEAR_FALLBACK}\n`);
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
