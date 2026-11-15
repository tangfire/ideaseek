import type { IdeaCheckReport } from './check.js';

/**
 * ARIS's preparation stop condition, applied before the code-repair loop.
 *
 * `compute-env-contract.md` §5 organises failures by LAYER — spec, build,
 * weights, resolution, exec — and `experiment-bridge/SKILL.md` says plainly
 * that missing access, authentication, networking or driver support is not
 * fixed by rewriting the training script. Without this check a blocked host
 * consumes the whole reimplement budget and the final report blames the code,
 * which is the wrong conclusion to hand a researcher.
 *
 * The vocabulary is IdeaSeek's existing one rather than a new invention: the
 * same block reasons the run engine already uses for QUOTA_EXHAUSTED,
 * AUTH_REQUIRED and NETWORK_BLOCKED.
 */
const ENV_PATTERNS: { reason: string; patterns: RegExp[] }[] = [
  {
    reason: 'model credentials or quota',
    patterns: [
      /\bquota[_ -]?exhausted\b/i,
      /\b(?:rate-limit|ratelimit|status[ =]?|error[ =]?)?429\b/i,
      /\binsufficient[_ -]?quota\b/i,
      /\bcredit[_ -]?balance\b/i,
      /\b401\b.*unauthorized/i,
      /\binvalid[_ -]?(api[_ -]?)?key\b/i,
    ],
  },
  {
    reason: 'network access',
    patterns: [
      /\bnetwork[_ -]?blocked\b/i,
      /\beconnrefused\b/i,
      /\beconnreset\b/i,
      /\btimed? out\b.*(?:download|fetch|install|index)/i,
      /\bcouldn't reach .*index\b/i,
      /\bfailure establishing connection\b/i,
      /\bname or service not known\b/i,
      /\bno matching distribution\b/i,
    ],
  },
  {
    reason: 'container or GPU support',
    patterns: [
      /\benv_unsupported\b/i,
      /\bcuda_error_no_device\b/i,
      /\bno cuda GPUs are available\b/i,
      /\bcannot initialize CUDA handle\b/i,
      /\bdocker\b.*(?:not found|permission denied|is not running|cannot connect)/i,
      /\bnvidia-smi not found\b/i,
      /\bdriver .*not loaded\b/i,
    ],
  },
];

export function detectEnvironmentBlock(report: IdeaCheckReport | null): string | null {
  if (!report) return null;
  for (const phase of report.phases) {
    if (phase.skipped || phase.ok) continue;
    const text = `${phase.failureKind ?? ''} ${phase.summary ?? ''} ${phase.command.join(' ')}`;
    for (const candidate of ENV_PATTERNS) {
      if (candidate.patterns.some((pattern) => pattern.test(text))) {
        return (
          `environment/preparation blocker (${candidate.reason}) at the ${phase.phase} phase: ` +
          `${phase.summary ?? phase.failureKind ?? 'failed'} — rewriting the program cannot fix ` +
          'this; restore access, then rerun (attempts kept)'
        );
      }
    }
  }
  return null;
}
