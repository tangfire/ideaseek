import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { IdeaseekError } from '../core/errors.js';
import { assessIdeaCard } from '../idea/card.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek idea validate <file>` — IdeaCard contract + mechanism gate.
 * Structural errors exit 2; a DRAFT_COMPOSITION card passes validation but is
 * reported as blocked from the experiment queue (add --require-candidate to
 * make that a failing exit, for pre-experiment checks).
 */
export function registerIdeaCommand(program: Command): void {
  const idea = program.command('idea').description('idea cards, versions and the mechanism gate');

  idea
    .command('validate')
    .description('validate an IdeaCard JSON and run the DRAFT_COMPOSITION mechanism gate')
    .argument('<file>', 'path to the idea card JSON')
    .option('--require-candidate', 'fail when the card is held at DRAFT_COMPOSITION')
    .option('--json', 'machine-readable output')
    .action(
      action(async (file: string, opts: { requireCandidate?: boolean; json?: boolean }) => {
        let raw: string;
        try {
          raw = await readFile(file, 'utf8');
        } catch (error) {
          throw new IdeaseekError(
            'FILE_NOT_FOUND',
            `cannot read ${file}: ${(error as Error).message}`,
          );
        }
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch (error) {
          throw new IdeaseekError(
            'PARSE_FAILED',
            `${file} is not valid JSON: ${(error as Error).message}`,
          );
        }

        const { validation, gate, ok } = assessIdeaCard(value);
        const ideaId =
          value &&
          typeof value === 'object' &&
          typeof (value as { ideaId?: unknown }).ideaId === 'string'
            ? (value as { ideaId: string }).ideaId
            : null;
        const version =
          value &&
          typeof value === 'object' &&
          typeof (value as { version?: unknown }).version === 'number'
            ? (value as { version: number }).version
            : null;

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              version,
              valid: ok,
              errors: validation.errors,
              gate: gate.status,
              blockers: gate.blockers,
              eligibleForQueue: ok && gate.ok,
            }),
          );
        } else {
          if (validation.errors.length > 0) {
            process.stdout.write(`invalid idea card (${validation.errors.length} error(s)):\n`);
            for (const error of validation.errors) process.stdout.write(`  ✗ ${error}\n`);
          } else {
            process.stdout.write(`valid idea card: ${ideaId ?? '?'} v${version ?? '?'}\n`);
          }
          process.stdout.write(`mechanism gate: ${gate.status}\n`);
          for (const blocker of gate.blockers) process.stdout.write(`  • ${blocker}\n`);
          if (ok && gate.ok) {
            process.stdout.write(
              'eligible for the experiment queue (subject to user confirmation)\n',
            );
          } else if (ok) {
            process.stdout.write(
              'held at DRAFT_COMPOSITION: complete the mechanism chain before experiments\n',
            );
          }
        }

        if (!ok) return 2;
        if (opts.requireCandidate && !gate.ok) return 2;
        return 0;
      }),
    );
}
