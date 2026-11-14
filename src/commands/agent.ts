import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { APPROVAL_ALLOW, encodeApprovalRequest } from '../dsh/approval-channel.js';
import type { InputDriftReport } from '../knowledge/input-drift.js';
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

/** Stated once per general-scope turn: what is NOT guaranteed outside a project. */
const GENERAL_SCOPE_NOTICE =
  '通用 coding 回合（当前目录不是 IdeaSeek 项目）：不记 RunEvent、不做原始输入漂移侦测、' +
  '不注入项目摘要；回合本身进用户级会话列表（`ideaseek agent --list` / TUI `/agent` 可回看）。';

/** Canned agent turn for tests (IDEASEEK_FAKE_AGENT_TURN=1). */
async function runFakeAgentTurn(
  prompt: string,
  json: boolean,
  resume: boolean,
  root: string | null,
  cwd: string,
): Promise<number> {
  const sessionId = 'session-fake-e2e';
  process.stderr.write('  · dsh runtime started\n');
  process.stderr.write(
    resume ? `  · resumed session ${sessionId}\n` : `  · new session ${sessionId}\n`,
  );
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
  // Mirror the real path: record the session so the NEXT TUI can seed
  // --resume from the registry (cross-restart continuity e2e).
  const { recordAgentSession } = await import('../dsh/session.js');
  await recordAgentSession(root, { sessionId, prompt, cwd, finishReason: 'completed' });
  // Outside a project there is no baseline to compare and no run to audit.
  const drift = root ? await checkInputDriftAfterTurn(root) : null;
  const { renderDriftReport } = await import('../knowledge/input-drift.js');
  if (json) {
    process.stdout.write(
      jsonLine({
        sessionId,
        resumed: resume,
        scope: root ? 'project' : 'general',
        finishReason: 'completed',
        eventCount: 3,
        approvals: approval
          ? [{ outcome: allowed ? 'allowed-once' : 'rejected', toolName: approval.toolName }]
          : [],
        response,
        eventSeq: null,
        inputDrift: drift ? inputDriftJson(drift.report) : null,
        inputDriftEventSeq: drift?.eventSeq ?? null,
      }),
    );
    return 0;
  }
  process.stdout.write(
    `agent turn → session ${sessionId} (${resume ? 'resumed' : 'new'}, finish=completed, 3 event(s))\n`,
  );
  if (approval) {
    process.stdout.write(
      `  approval ${allowed ? 'allowed-once' : 'rejected'}: ${approval.toolName}\n`,
    );
  }
  process.stdout.write(`  ${response}\n`);
  if (drift) for (const line of renderDriftReport(drift.report)) process.stdout.write(`${line}\n`);
  else process.stdout.write(`  ${GENERAL_SCOPE_NOTICE}\n`);
  process.stdout.write(`next: ideaseek agent "<prompt>" --resume ${sessionId}\n`);
  return 0;
}

/**
 * Post-turn provenance check (docs/MODES.md「不禁止写入，但侦测写入」). The agent
 * runs on DSH's `workspace-write` preset and may legitimately edit anything, so
 * integrity comes from noticing, not blocking: compare the hashed inputs against
 * disk, record an event, and tell the user which conclusions are no longer
 * verifiable. Neutral attribution — this is a delta since the last `scan`.
 */
async function checkInputDriftAfterTurn(root: string): Promise<{
  report: InputDriftReport;
  eventSeq: number | null;
}> {
  const { detectInputDrift, driftEventSummary, hasInputDrift } =
    await import('../knowledge/input-drift.js');
  const report = await detectInputDrift(root);
  if (!hasInputDrift(report)) return { report, eventSeq: null };
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  let eventSeq: number | null = null;
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (run) {
      const event = await runtime.db.appendEvent({
        runId: run.runId,
        phase: 'DECISION',
        objectId: 'input-drift',
        role: 'system',
        eventType: 'input_drift',
        summary: driftEventSummary(report),
        status: 'stale',
      });
      eventSeq = event.seq;
    }
  } finally {
    await runtime.close();
  }
  return { report, eventSeq };
}

/** Machine shape for `--json` (bounded: a bulk rewrite must not flood stdout). */
function inputDriftJson(report: InputDriftReport) {
  return {
    roots: report.roots,
    hasBaseline: report.hasBaseline,
    hashMatched: report.checked,
    unchecked: report.unchecked,
    drifted: report.drifted.length,
    changes: report.drifted.slice(0, 20).map((file) => ({
      path: file.relPath,
      change: file.change,
    })),
  };
}

/**
 * First turn of a NEW session carries a compact project brief (docs/MODES.md):
 * a general agent dropped into a research folder otherwise has no idea the
 * folder means anything. Resumed sessions already hold this in their history,
 * so only a fresh session pays the extra tokens. Built from persisted state
 * only — never from a model's memory of the project.
 */
export async function composeTurnPrompt(
  root: string,
  prompt: string,
  isNewSession: boolean,
): Promise<string> {
  if (!isNewSession) return prompt;
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const { readSessionMode } = await import('../session/mode.js');
  let brief: string[];
  try {
    const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
    try {
      const run = await runtime.db.getLatestRun(runtime.project.id);
      brief = [
        `[IdeaSeek 项目上下文｜本回合为新建 session 的一次性注入]`,
        `project: ${runtime.project.name} (${root})`,
        `research tier: ${await readSessionMode(root)}`,
        run
          ? `question: ${String(run.question ?? '').slice(0, 300)}`
          : 'question: 尚未开始 run（尚无研究问题记录）',
        `provenance anchors: papers/、datasets/、comparisons/upstream/ 的内容已被 hash 记录；改动会被侦测并使下游结论失效。要改数据请写派生版本或处理后走 scan/datasets link。`,
        `科研语义（指标/split/comparison/假设/协议）不在本回合里静默改；需要时说明并由用户在 Research 面确认。`,
      ];
    } finally {
      await runtime.close();
    }
  } catch {
    // No project state yet (fresh init, no run, DB unavailable): an agent turn
    // must still run. Inject nothing rather than a half-built brief.
    return prompt;
  }
  return `${brief.join('\n')}\n\n--- 用户指令 ---\n${prompt}`;
}

/**
 * `ideaseek agent` — the general-purpose entry, a REAL DSH coding session
 * (docs/ARCHITECTURE research-cli; no fixed greetings, no ask-supervisor
 * stand-in): one prompt → pinned DSH runtime → named/resumable session with
 * the working directory as cwd; tool approvals are operator-driven on a TTY,
 * via the parent shell's stdio channel, and default to rejected everywhere
 * else.
 *
 * It runs in ANY directory, because "IdeaSeek is also my everyday coding
 * agent" is the product requirement (docs/MODES.md). Inside an IdeaSeek
 * project the turn additionally gets an audited Decision/Event, a provenance
 * drift check and a first-turn project brief; outside one it is a plain DSH
 * session and says which guarantees are off, rather than quietly pretending
 * the research guarantees still hold.
 */
export function registerAgentCommand(program: Command): void {
  program
    .command('agent')
    .description(
      'run one real DSH coding-session turn in this directory (approvals: TTY prompt, else rejected)',
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
          // No project required: this is the everyday entry. `root` only decides
          // whether the research-side guarantees (audit, drift, brief) apply.
          const root = await findProjectRoot(process.cwd());
          const turnCwd = root ?? process.cwd();

          const { agentSessionsPath, readAgentSessions, recordAgentSession } =
            await import('../dsh/session.js');

          if (opts.list) {
            const { sessions } = await readAgentSessions(root);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  sessions,
                  registry: agentSessionsPath(root),
                  scope: root ? 'project' : 'general',
                }),
              );
              return 0;
            }
            if (sessions.length === 0) {
              process.stdout.write(
                `no agent sessions yet — ideaseek agent "<prompt>" (registry: ${agentSessionsPath(root)})\n`,
              );
              return 0;
            }
            process.stdout.write(
              `${sessions.length} agent session(s) (${agentSessionsPath(root)}):\n`,
            );
            for (const session of sessions) {
              process.stdout.write(
                `  ${session.sessionId}  ${new Date(session.updatedAt).toISOString()}  ` +
                  `${session.scope.padEnd(7)}${String(session.turns).padStart(3)} turn(s)  ${session.title}\n`,
              );
              process.stdout.write(
                `      cwd: ${session.cwd || '(recorded before cwd was tracked)'}` +
                  `${session.lastFinish ? `  last: ${session.lastFinish}` : ''}\n`,
              );
            }
            process.stdout.write('  resume: ideaseek agent "<指令>" --resume <id>\n');
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
            return await runFakeAgentTurn(
              prompt,
              opts.json === true,
              opts.resume !== undefined,
              root,
              turnCwd,
            );
          }

          const { runAgentTurn, redactAgentText } = await import('../dsh/session.js');
          const result = await runAgentTurn({
            cwd: turnCwd,
            prompt: root
              ? await composeTurnPrompt(root, prompt, opts.resume === undefined)
              : prompt,
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
            cwd: turnCwd,
            finishReason: result.finishReason ?? null,
          });

          // Audited turn: truncated + redacted, never the key material. Only a
          // project has a run to attach the event to.
          let eventSeq: number | null = null;
          if (root) {
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
          }

          const drift = root ? await checkInputDriftAfterTurn(root) : null;
          const { renderDriftReport } = await import('../knowledge/input-drift.js');

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                sessionId: result.sessionId,
                resumed: result.resumed,
                scope: root ? 'project' : 'general',
                finishReason: result.finishReason,
                eventCount: result.eventCount,
                approvals: result.approvals,
                response: result.finalResponse,
                eventSeq,
                inputDrift: drift ? inputDriftJson(drift.report) : null,
                inputDriftEventSeq: drift?.eventSeq ?? null,
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
          if (drift) {
            for (const line of renderDriftReport(drift.report)) process.stdout.write(`${line}\n`);
          } else {
            process.stdout.write(`  ${GENERAL_SCOPE_NOTICE}\n`);
          }
          process.stdout.write(`next: ideaseek agent "<prompt>" --resume ${result.sessionId}\n`);
          return 0;
        },
      ),
    );
}
