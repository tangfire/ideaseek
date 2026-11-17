import { isAbsolute, join, relative } from 'node:path';
import { redactSecrets } from '../core/redact.js';
import { IdeaseekError } from '../core/errors.js';
import { runAgentTurn, type ApprovalPolicy } from '../dsh/session.js';
import { hashIdeaSource, ideaDir, listSourceFiles } from './workspace.js';
import type { IdeaCard } from './card.js';
import { runIdeaChecks, scaffoldFiles, type IdeaCheckReport } from './check.js';
import {
  clearGeneratedIdeaFiles,
  recordAuthoredIdeaFiles,
  unrecordedSourceFiles,
} from './implement-clean.js';

/**
 * Implementing an idea with an agent that has tools, instead of one that has
 * to hand back whole files as JSON strings.
 *
 * The earlier design asked a tool-less reasoning profile for
 * `{"files":[{path,content}]}` and then ran a check ladder on the result. That
 * worked, and it was also the least capable shape available: the agent could
 * not open the failing log, could not run the program it had just written,
 * could not iterate on a traceback — every one of those steps became a fresh
 * full-file generation, bounded by an output token cap that had already
 * truncated real answers. On FDG the loop spent its whole ARIS budget and still
 * could not get past a matmul shape error it would have seen immediately if it
 * had been able to run the code.
 *
 * This is the same platform primitive `ideaseek agent` already uses: a real DSH
 * coding session, scoped to the idea workspace, resumable by session id. The
 * agent writes and runs; the platform still owns the verdict (the check ladder
 * is deterministic and runs outside the session) and the boundary (file tools
 * are confined to ideas/<id>, approvals follow the operator's policy, and the
 * turn count bounds cost).
 */

/** Bound cost, not conclusions: the platform's own budget rule. */
export const MAX_AGENT_IMPLEMENT_ROUNDS = 4;

const IMPLEMENT_TASK = `Implement this research idea inside the current working directory.

Rules for the work itself:
- Write the code under src/. src/smoke.py is the entry the platform runs: it must read the corpus
  the environment points at (IDEASEEK_DATA_PATH, else IDEASEEK_DATASET_ROOTS, else
  IDEASEEK_PROJECT_ROOT) and print exactly one JSON line {"metrics": {...}} whose keys are exactly
  the metric names the idea card declares.
- Import sibling modules by bare name; src/ is on the search path when the platform runs
  "python src/<file>.py".
- The platform runs src/train.py with "--scale quick|standard" for anything beyond the smoke
  check. That entry must consume a LARGER slice than src/smoke.py and print "scale" set to the
  value it was given. Reusing the smoke computation under a quick label is refused by the
  platform, and recording it would claim more evidence than exists.
- RUN what you wrote before you finish. Execute src/smoke.py, read the traceback, fix it, and
  repeat until it prints real computed values. Do not declare success you have not observed.
- Never emit placeholder, constant, or self-declared synthetic metric values. A metrics line
  carrying "synthetic" is refused by the platform, and a number that reaches a results record
  without having been computed is worse than a failing run.
- When the card names baselines, MEASURE them in this same run and print them beside the metrics:
  {"metrics": {...}, "baselines": {"<methodId>": {"<primary metric name>": <value>}}}. A plain
  {"baselines": {"<methodId>": <value>}} is accepted too. Those become recorded comparisons with
  the run's own scale and seeds, which is the best-paired evidence this platform can hold. A number
  copied from a paper, a README or another idea's output is not a measurement: report only what this
  run computed, and say in your final message which controls you could not afford to run.
- Use only the standard library and packages the idea card declares. If one is unavailable, say so
  in your final message instead of working around it silently.
- Keep the scope of the card's minimalExperiment. Do not build a training stack the card did not
  ask for, and do not narrow the claim to make a check go green.`;

export interface AgentImplementationRound {
  round: number;
  sessionId: string;
  outcome: IdeaCheckReport['outcome'];
  failing: { phase: string; kind: string; summary: string }[];
  /** The agent's own closing statement for the round, redacted and shortened. */
  agentReport: string;
  /**
   * Paths under src/ this round's session authored (new or content-changed).
   * This is what makes a passed verdict reproducible: without it the platform
   * cannot say which files a `SMOKE_TESTED` run is standing on.
   */
  authored: string[];
}

export interface AgentImplementationResult {
  passed: boolean;
  rounds: AgentImplementationRound[];
  sessionId: string | null;
  report: IdeaCheckReport | null;
  /** A check outcome that no further agent turn can change. */
  terminal: boolean;
  /**
   * `src/` files present at the start that were neither the scaffold template
   * nor recorded as generated. They are kept — unrecorded does not mean
   * disposable — but a pass standing on them is not a pass this session
   * produced, so the caller has to say so.
   */
  unrecordedAtStart: string[];
}

function failingSummary(report: IdeaCheckReport): string {
  return report.phases
    .filter((phase) => !phase.skipped && !phase.ok)
    .map(
      (phase) =>
        `- ${phase.phase} (${phase.failureKind ?? 'failed'}): ${phase.summary ?? ''}\n` +
        `  log: ${phase.logPath ?? '(none recorded)'}`,
    )
    .join('\n');
}

/**
 * Prompt for a follow-up round. Short on purpose: the session already holds
 * what the agent wrote and ran, so repeating it wastes the context the fix
 * needs. Pointing at the log file is better than pasting it, because the agent
 * can read the whole trace rather than the tail the platform guessed at.
 */
/**
 * Follow-up prompt for a round, and the FULL contract when context is gone.
 *
 * The rounds after the first assume the session still holds the card, the task
 * rules and the code it wrote — normally true, because DSH persists session
 * history. But `runAgentTurn` swallows a failed resume and opens a fresh
 * session (session.ts logs it and continues), so a follow-up could arrive as
 * "Round 3: the ladder failed — open these logs" to an agent that has never
 * seen the card, the metric contract or its own previous reasoning. The agent
 * then debugs blind, and the platform pays four rounds of tokens for an answer
 * to a question it never asked. Attaching the contract again is the only fix
 * that keeps working whether or not the resume succeeded.
 */
export function followupPrompt(
  report: IdeaCheckReport,
  round: number,
  context?: { cardText: string; contextLost: boolean },
): string {
  const summary = failingSummary(report);
  // A lost session means the agent has never seen the card, the rules or its own
  // earlier work, so the restatement is prepended rather than the summary being
  // sent alone. When the resume succeeded the prompt stays short — repeating the
  // whole contract into a session that already holds it wastes the context the
  // fix needs, which is why the short form was the design in the first place.
  const preamble = context?.contextLost
    ? `Round ${round}: the platform ran the check ladder against your code and it failed.\n` +
      'NOTE: your previous session context could not be restored, so the platform is ' +
      'restating the whole task. Nothing from an earlier round is available to you — read ' +
      'the files in your workspace before changing them.\n\n' +
      `${context.cardText}\n\n${IMPLEMENT_TASK}\n\n`
    : `Round ${round}: the platform ran the check ladder against your code and it failed.\n`;
  return (
    preamble +
    `${summary}\n\n` +
    'Open those log files, find the actual cause, fix it in place, and re-run the failing ' +
    'command yourself until it produces real metric values. Do not restructure the design to ' +
    'route around the error, and do not hardcode metric values. If the failure is not something ' +
    'code can fix (missing data, missing package, a contradiction in the idea card itself), say ' +
    'that plainly and stop.'
  );
}

export async function implementIdeaWithAgent(opts: {
  projectRoot: string;
  ideaId: string;
  card: IdeaCard;
  measuredData: string | null;
  dataPath: string | null;
  policy: ApprovalPolicy;
  model?: string;
  provider?: string;
  maxRounds?: number;
  requestTimeoutMs?: number;
  /**
   * The locked protocol's metric declarations, verbatim. Handed to the agent as
   * what to emit and to the ladder as what to check — see
   * `RunChecksOptions.metricContract`.
   */
  metricContract?: string[];
  /** runtime.pip_index_url, for the venv the ladder builds (see RunChecksOptions). */
  pipIndexUrl?: string;
  /**
   * Tools the operator pre-granted for these sessions (capability names). Empty
   * by default, and an implementation turn with no grant and no terminal
   * refuses to start rather than burning rounds on code it cannot run.
   */
  allowTools?: string[];
  /**
   * The human channel for tool approvals. A TTY on its own is not one: with no
   * prompter attached, an `interactive` policy still refuses everything, and a
   * real implementation run spent four rounds writing code nothing would run
   * for it. Callers that can ask a person pass this (see askForApprovalOnce).
   */
  promptFn?: (request: { toolName: string; reason: string | null }) => Promise<boolean>;
  onStep?: (line: string) => void;
  onLog?: (message: string) => void;
}): Promise<AgentImplementationResult> {
  const workspace = ideaDir(opts.projectRoot, opts.ideaId);
  // A tool-enabled turn is confined by its working directory: the agent may
  // write and run inside this idea's workspace, while papers/, datasets/ and
  // comparisons/upstream/ stay read-only inputs. Compared with relative()
  // rather than string prefixes — a separator-sensitive check refused every
  // legitimate Windows path the first time it ran, and a guard that rejects
  // valid work is worse than no guard, because it gets removed under pressure.
  const relativeToIdeas = relative(join(opts.projectRoot, 'ideas'), workspace);
  if (
    relativeToIdeas.startsWith('..') ||
    isAbsolute(relativeToIdeas) ||
    relativeToIdeas === '' ||
    relativeToIdeas.includes('..')
  ) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `agent implementation must run inside ideas/<id>; refused ${workspace}`,
    );
  }
  const rounds: AgentImplementationResult['rounds'] = [];
  let sessionId: string | null = null;
  let report: IdeaCheckReport | null = null;
  let terminal = false;
  let lastHash: string | null = null;
  // Set when a turn asked for a persisted session and did not get it back; the
  // next prompt must then restate the whole contract (see `followupPrompt`).
  let contextLost = false;
  // Snapshot of src/ taken once, after the round-1 clear: every file that
  // differs from it afterwards was authored by this session.
  let baseline = new Map<string, string>();
  let unrecordedAtStart: string[] = [];

  const cardText = [
    `## idea card\n${opts.card.ideaId} v${opts.card.version}`,
    `## hypothesis\n${opts.card.hypothesis.statement}\ntarget problem: ${opts.card.hypothesis.targetProblem}`,
    `## mechanism chain\n${opts.card.mechanismChain.steps
      .map((step, index) => `${index + 1}. [${step.kind}] ${step.text}`)
      .join('\n')}`,
    `## minimal experiment (scope)\ncode: ${opts.card.minimalExperiment.code}\ndata: ${opts.card.minimalExperiment.data}\nbaselines: ${opts.card.minimalExperiment.baselines.join(', ')}\nmetrics: ${opts.card.minimalExperiment.metrics.join(', ')}`,
    opts.metricContract && opts.metricContract.length > 0
      ? `## metric contract (the locked protocol declares the unit)\n` +
        opts.metricContract.map((metric) => `- ${metric}`).join('\n') +
        `\nEvery metric key your code prints must appear here or be one of the card metrics above; ` +
        `where a contract entry denotes the same measurement as a card metric, print the CONTRACT ` +
        `identifier and report the value in the unit it declares (a metric declared "%" is 0-100, ` +
        `not 0-1). The platform refuses a recorded value that contradicts the declared unit.`
      : '',
    `## nearest comparisons\n${
      opts.card.nearestComparisons
        .map((item) => `- ${item.methodId}: ${item.difference}`)
        .join('\n') || '(none)'
    }`,
    opts.measuredData
      ? `## measured data structure (trust over assumption)\n${opts.measuredData}`
      : '## measured data structure\n(not profiled — probe the handed path and report what it holds)',
    `## data path handed to the checks\n${opts.dataPath ?? '(use the environment)'}`,
    unrecordedAtStart.length > 0
      ? `## files already in src/ with no generation record\n${unrecordedAtStart.join('\n')}\n` +
        "These may be a researcher's work or an earlier attempt. Read them before writing: reuse " +
        'or fix them deliberately, never assume they are correct, and never delete one because ' +
        'its origin is unclear.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  for (let round = 1; round <= (opts.maxRounds ?? MAX_AGENT_IMPLEMENT_ROUNDS); round += 1) {
    if (round === 1) {
      // Start from a clean slate so the scaffold template cannot survive into
      // the round that is supposed to be grading new work.
      await clearGeneratedIdeaFiles(workspace);
      baseline = await listSourceFiles(workspace);
      unrecordedAtStart = await unrecordedSourceFiles(workspace, scaffoldFiles(opts.card));
    }
    const turn = await runAgentTurn({
      cwd: workspace,
      prompt:
        sessionId === null
          ? `${IMPLEMENT_TASK}\n\n${cardText}`
          : followupPrompt(report!, round, { cardText, contextLost }),
      ...(sessionId ? { sessionId } : {}),
      policy: opts.policy,
      // This task is definitionally executable: an idea implementation that
      // cannot run its own code cannot reach the ladder's pass verdict, so the
      // turn says up front whether it is able to (see `AgentTurnOptions`).
      needsExecution: true,
      ...(opts.promptFn ? { promptFn: opts.promptFn } : {}),
      ...(opts.allowTools && opts.allowTools.length > 0 ? { allowTools: opts.allowTools } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      onStep: opts.onStep,
      onLog: opts.onLog,
    });
    // `resumed` is the runtime's own answer: false with a sessionId we passed
    // means the history could not be reloaded, so whatever this turn received
    // was a bare follow-up instruction with no context behind it.
    contextLost = sessionId !== null && turn.resumed === false;
    sessionId = turn.sessionId;
    const authored = await recordAuthoredIdeaFiles(workspace, baseline);

    report = await runIdeaChecks(opts.projectRoot, opts.ideaId, {
      metricContract: opts.metricContract ?? [],
      pipIndexUrl: opts.pipIndexUrl,
    });
    const failing = report.phases
      .filter((phase) => !phase.skipped && !phase.ok)
      .map((phase) => ({
        phase: phase.phase,
        kind: phase.failureKind ?? 'failed',
        summary: redactSecrets(phase.summary ?? '').slice(0, 300),
      }));
    rounds.push({
      round,
      sessionId: turn.sessionId,
      outcome: report.outcome,
      failing,
      agentReport: redactSecrets(turn.finalResponse).slice(0, 600),
      authored,
    });

    if (report.outcome === 'passed') break;
    if (report.outcome === 'not-implemented') {
      // The agent wrote nothing runnable; another prompt about the same card
      // is a coin flip, and the honest report is that tools were declined.
      terminal = true;
      break;
    }

    const hash = await hashIdeaSource(opts.projectRoot, opts.ideaId);
    if (lastHash !== null && lastHash === hash) {
      // The agent did not touch src/ this round: approvals were declined, or it
      // believes it is finished while the checker disagrees. Either way another
      // turn costs tokens and changes nothing, so say so instead of retrying.
      terminal = true;
      break;
    }
    lastHash = hash;
  }

  return {
    passed: report?.outcome === 'passed',
    rounds,
    sessionId,
    report,
    terminal,
    unrecordedAtStart,
  };
}
