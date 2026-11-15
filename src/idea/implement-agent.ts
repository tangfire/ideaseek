import { isAbsolute, join, relative } from 'node:path';
import { redactSecrets } from '../core/redact.js';
import { IdeaseekError } from '../core/errors.js';
import { runAgentTurn, type ApprovalPolicy } from '../dsh/session.js';
import { hashIdeaSource, ideaDir } from './workspace.js';
import type { IdeaCard } from './card.js';
import { runIdeaChecks, type IdeaCheckReport } from './check.js';
import { clearGeneratedIdeaFiles } from './implement-clean.js';

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
- RUN what you wrote before you finish. Execute src/smoke.py, read the traceback, fix it, and
  repeat until it prints real computed values. Do not declare success you have not observed.
- Never emit placeholder, constant, or self-declared synthetic metric values. A metrics line
  carrying "synthetic" is refused by the platform, and a number that reaches a results record
  without having been computed is worse than a failing run.
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
}

export interface AgentImplementationResult {
  passed: boolean;
  rounds: AgentImplementationRound[];
  sessionId: string | null;
  report: IdeaCheckReport | null;
  /** A check outcome that no further agent turn can change. */
  terminal: boolean;
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
function followupPrompt(report: IdeaCheckReport, round: number): string {
  const summary = failingSummary(report);
  return (
    `Round ${round}: the platform ran the check ladder against your code and it failed.\n` +
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

  const cardText = [
    `## idea card\n${opts.card.ideaId} v${opts.card.version}`,
    `## hypothesis\n${opts.card.hypothesis.statement}\ntarget problem: ${opts.card.hypothesis.targetProblem}`,
    `## mechanism chain\n${opts.card.mechanismChain.steps
      .map((step, index) => `${index + 1}. [${step.kind}] ${step.text}`)
      .join('\n')}`,
    `## minimal experiment (scope)\ncode: ${opts.card.minimalExperiment.code}\ndata: ${opts.card.minimalExperiment.data}\nbaselines: ${opts.card.minimalExperiment.baselines.join(', ')}\nmetrics: ${opts.card.minimalExperiment.metrics.join(', ')}`,
    `## nearest comparisons\n${
      opts.card.nearestComparisons
        .map((item) => `- ${item.methodId}: ${item.difference}`)
        .join('\n') || '(none)'
    }`,
    opts.measuredData
      ? `## measured data structure (trust over assumption)\n${opts.measuredData}`
      : '## measured data structure\n(not profiled — probe the handed path and report what it holds)',
    `## data path handed to the checks\n${opts.dataPath ?? '(use the environment)'}`,
  ].join('\n\n');

  for (let round = 1; round <= (opts.maxRounds ?? MAX_AGENT_IMPLEMENT_ROUNDS); round += 1) {
    if (round === 1) {
      // Start from a clean slate so the scaffold template cannot survive into
      // the round that is supposed to be grading new work.
      await clearGeneratedIdeaFiles(workspace);
    }
    const turn = await runAgentTurn({
      cwd: workspace,
      prompt:
        sessionId === null ? `${IMPLEMENT_TASK}\n\n${cardText}` : followupPrompt(report!, round),
      ...(sessionId ? { sessionId } : {}),
      policy: opts.policy,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      onStep: opts.onStep,
      onLog: opts.onLog,
    });
    sessionId = turn.sessionId;

    report = await runIdeaChecks(opts.projectRoot, opts.ideaId);
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
  };
}
