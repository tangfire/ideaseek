import type { Command } from 'commander';
import { action, jsonLine } from './shared.js';
import { ARIS_SOURCE, VENDORED_FILES, VENDORED_SKILLS } from '../aris/manifest.js';
import { arisSkillsRoot, verifyVendoredIntegrity } from '../aris/skill.js';

/**
 * `ideaseek aris` — vendored ARIS skill provenance and integrity
 * (docs/ARIS_INTEGRATION_PLAN.md 许可证和闭源产品): shows the pinned source
 * commit, MIT license, the P0 skill list and a SHA-256 verification of
 * every vendored file. Exit 0 when intact, 2 on any mismatch so scripts
 * and `doctor`-style checks can gate on it.
 */
export function registerArisCommand(program: Command): void {
  program
    .command('aris')
    .description('show vendored ARIS skills: source commit, license and file integrity')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const reports = await verifyVendoredIntegrity();
        const ok = reports.every((report) => report.ok);
        const broken = reports.filter((report) => !report.ok);

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              source: ARIS_SOURCE,
              root: arisSkillsRoot(),
              skills: VENDORED_SKILLS,
              fileCount: VENDORED_FILES.length,
              integrity: ok ? 'ok' : 'mismatch',
              broken: broken.map((report) => report.path),
            }),
          );
          return ok ? 0 : 2;
        }

        process.stdout.write(`ARIS source: ${ARIS_SOURCE.repository}\n`);
        process.stdout.write(`  commit: ${ARIS_SOURCE.commit}\n`);
        process.stdout.write(`  license: ${ARIS_SOURCE.license} (${ARIS_SOURCE.copyright})\n`);
        process.stdout.write(`  vendored: ${ARIS_SOURCE.vendoredAt} → ${arisSkillsRoot()}\n`);
        process.stdout.write(
          `${VENDORED_SKILLS.length} P0 skills: ${VENDORED_SKILLS.join(', ')}\n`,
        );
        process.stdout.write(`${VENDORED_FILES.length} content files hashed in the manifest\n`);
        if (ok) {
          process.stdout.write('integrity: all files match the manifest\n');
        } else {
          process.stdout.write(`integrity: MISMATCH in ${broken.length} file(s):\n`);
          for (const report of broken) process.stdout.write(`  ✗ ${report.path}\n`);
          process.stdout.write(
            'next: restore aris-skills/ from the pinned commit (see aris-skills/NOTICE.md)\n',
          );
        }
        return ok ? 0 : 2;
      }),
    );
}
