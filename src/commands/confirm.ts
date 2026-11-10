import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { lockProtocolProposal, validateProtocolProposal } from '../experiment/protocol.js';
import { checkLeakage } from '../experiment/leakage.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek confirm protocol` — validates the latest committed protocol
 * proposal, records the user's confirmation as an immutable lock (hash +
 * confirmedBy) and surfaces every low-confidence agent inference that this
 * confirmation covers. Never locks an invalid proposal.
 */
export function registerConfirmCommand(program: Command): void {
  const confirm = program.command('confirm').description('confirm pending proposals');

  confirm
    .command('protocol')
    .description('validate and lock the latest protocol proposal')
    .option('--run <runId>', 'run to look for the proposal in (default: latest artifact)')
    .option('--by <who>', 'confirmer identity recorded in the lock', 'user')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; by?: string; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          let artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
          if (opts.run) {
            artifacts = artifacts.filter((entry) => entry.runId === opts.run);
            if (artifacts.length === 0) {
              throw new IdeaseekError('RUN_NOT_FOUND', `no protocol proposal in run ${opts.run}`);
            }
          }
          if (artifacts.length === 0) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              'no protocol proposal found; run the protocol synthesis flow first (requires model credentials)',
            );
          }
          const chosen = artifacts[artifacts.length - 1]!;

          const proposal = JSON.parse(
            await runtime.store.readFinalText(chosen.contentHash),
          ) as unknown;
          const validation = validateProtocolProposal(proposal);
          if (!validation.ok) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  locked: false,
                  errors: validation.errors,
                  confirmations: validation.confirmations,
                }),
              );
            } else {
              process.stdout.write('protocol proposal is INVALID, not locked:\n');
              for (const error of validation.errors) process.stdout.write(`  ✗ ${error}\n`);
            }
            return 2;
          }

          // Deterministic leakage/validity gate over registered slices: a
          // blocker finding stops the lock (pending items become confirmations).
          const sliceRecords = await runtime.db.listSlices();
          // Slices are generated FROM a locked protocol, so an empty registry
          // simply means the gate has nothing to check yet.
          const leakage =
            sliceRecords.length > 0
              ? checkLeakage({
                  slices: sliceRecords.map((entry) => entry.record as never),
                  now: Date.now(),
                })
              : { ok: true, findings: [], checkedAt: Date.now() };
          const blockers = leakage.findings.filter((finding) => finding.severity === 'blocker');
          if (blockers.length > 0) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  locked: false,
                  errors: blockers.map((finding) => finding.detail),
                  leakage: leakage.findings,
                }),
              );
            } else {
              process.stdout.write('leakage/validity gate FAILED, not locked:\n');
              for (const finding of blockers) {
                process.stdout.write('  ✗ ' + finding.check + ': ' + finding.detail + '\n');
              }
            }
            return 2;
          }
          const pending = leakage.findings.filter((finding) => finding.severity === 'pending');
          const lock = await lockProtocolProposal(proposal, {
            confirmedBy: opts.by ?? 'user',
            now: Date.now(),
          });
          const record = proposal as { protocolId: string } as unknown as Record<string, unknown>;
          const existing = await runtime.db.getProtocolLock(lock.protocolId);
          await runtime.db.lockProtocol({ ...lock, record });

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                locked: true,
                alreadyLocked: existing !== null,
                protocolId: lock.protocolId,
                protocolHash: lock.protocolHash,
                confirmedBy: lock.confirmedBy,
                confirmations: [
                  ...validation.confirmations,
                  ...pending.map((finding) => finding.detail),
                ],
                leakageFindings: pending.length,
                artifactId: chosen.artifactId,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `${existing ? 'already locked' : 'locked'} protocol ${lock.protocolId}\n`,
          );
          process.stdout.write(`  hash: ${lock.protocolHash}\n`);
          process.stdout.write(`  confirmed by: ${lock.confirmedBy}\n`);
          const covered = [
            ...validation.confirmations,
            ...pending.map((finding) => finding.detail),
          ];
          if (covered.length > 0) {
            process.stdout.write('  covered confirmations:\n');
            for (const item of covered) process.stdout.write(`    · ${item}\n`);
          }
          process.stdout.write('next: ideaseek data slices   (or continue the workflow)\n');
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
