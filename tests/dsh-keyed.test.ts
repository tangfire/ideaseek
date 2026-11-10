import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DshHarnessAdapter } from '../src/dsh/dsh-adapter.js';
import { validatePaperCard } from '../src/knowledge/papercard.js';
import { PAPERCARD_INSTRUCTION, PAPERCARD_PROMPT_VERSION } from '../src/worker/paper-handlers.js';
import { capabilityDecision } from '../src/dsh-plugins/capability-guard.js';

const HAS_KEY = Boolean(process.env.DEEPSEEK_API_KEY);

/**
 * Real-model integration (self-skips without credentials, same policy as
 * DSH's own e2e). Verifies the full credential + DSH + guard + schema path:
 * a schema-compliant card from the live provider, with zero non-allowlisted
 * tool usage, executed within the recorded budget.
 */
describe('real DSH extraction (keyed integration)', () => {
  it('produces a validator-compliant card with only allowlisted tool usage', async () => {
    if (!HAS_KEY) return; // no credential: contract covered by fake harness tests
    const dshHome = await mkdtemp(join(tmpdir(), 'ideaseek-keyed-'));
    const adapter = new DshHarnessAdapter({
        dshHome,
        cwd: process.cwd(),
        initializeTimeoutMs: 60_000, // parallel DSH boots in the shared suite
      });
    try {
      const result = await adapter.runTask(
        {
          runId: 'keyed-test',
          taskId: 'keyed-1',
          profile: 'paper-extractor',
          instruction: PAPERCARD_INSTRUCTION,
          inputs: [
            {
              kind: 'text',
              name: 'excerpt',
              content:
                '[page 1]\nTitle: Widgets on Benchmarks. ' +
                'We evaluate on dataset X: accuracy 42.0 versus baseline B at 40.1. ' +
                'Ablation without the gate drops to 37.5.\n' +
                '[page 2]\nLimitations: only synthetic widgets were tested.',
            },
          ],
          outputSchema: 'papercard-v1',
          budget: { timeoutMs: 180_000, maxOutputTokens: 8192 },
          idempotencyKey: `keyed-${Date.now()}`,
        },
        undefined,
        undefined,
      );

      const modelCard = JSON.parse(result.output) as Record<string, unknown>;
      // Mirror the platform stamps the extract handler applies.
      const card = {
        ...modelCard,
        paper_id: 'paper-000000000000',
        document_hash: `sha256:${'f'.repeat(64)}`,
        parser_version: 'pypdf/7.0.0',
        prompt_schema_version: 'papercard-v1',
      };
      const validation = validatePaperCard(card);
      expect(validation.errors).toEqual([]);
      expect(String(modelCard.title ?? '')).not.toBe('');
      const claims = modelCard.claims as { evidence: { quote: string }[] }[];
      expect(claims.length).toBeGreaterThan(0);
      expect(claims[0]!.evidence[0]!.quote.length).toBeGreaterThan(10);

      // Capability guard: only research tools may appear in the audit trail.
      for (const call of result.toolCalls) {
        expect(capabilityDecision(call.tool).kind).toBe('allow');
      }
      expect(result.runtime.kind).toBe('dsh');
      expect(PAPERCARD_PROMPT_VERSION).toContain('papercard-v1');
    } finally {
      await adapter.shutdown();
    }
  }, 300_000);
});
