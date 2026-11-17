import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

export const EXTRACTOR_PRESET_ID = 'ideaseek-extractor';

/**
 * Which capability rows to mount.
 *
 * `extractor` is the Phase 1-2 profile: the read-only research tool surface
 * plus the preset that makes it the agent's default.
 *
 * `coding` deliberately omits the preset-registry row. That row sets the
 * *default agent preset*, and a coding session whose tools were restricted to
 * the extractor surface could not write or run anything — which is exactly how
 * the capability guard ended up never applying to the flagship path at all: the
 * implementation turns mounted no patch rather than mount a disabling one. The
 * coding role keeps DSH's own tool visibility and takes only the guard, whose
 * read fence is what the session actually needs.
 */
export type CapabilityRole = 'extractor' | 'coding';

export interface CapabilityPatch {
  /** Absolute path of the generated patch YAML for DeepSeekHarness.patches. */
  patchPath: string;
  /** The patch content (also useful for tests/debugging). */
  yaml: string;
  pluginPaths: { researchTools: string; extractorProfile: string; capabilityGuard: string };
}

function siblingSource(moduleDir: string, name: string): string {
  // Prefer the compiled .js next to dist modules; fall back to the TypeScript
  // source when running from src (vitest / tsx).
  const jsPath = join(moduleDir, '..', 'dsh-plugins', `${name}.js`);
  const tsPath = join(moduleDir, '..', 'dsh-plugins', `${name}.ts`);
  if (existsSync(jsPath)) return jsPath;
  if (existsSync(tsPath)) return tsPath;
  // Source layout: src/dsh/capability.ts → src/dsh-plugins/<name>.ts
  return tsPath;
}

/**
 * Generates the IdeaSeek Cordis patch for the DSH `sdk` profile:
 * - inserts the research-tools plugin (project_read tool + schema);
 * - inserts the agent-preset registry defaulting to our extractor preset;
 * - inserts the extractor preset whose child restricts the tool allowlist.
 *
 * Absolute plugin paths are required by the DSH loader, so the patch is
 * generated at runtime into the project's DSH home instead of being committed.
 * File-system authority additionally comes from DSH_PERMISSION_MODE=read-only
 * (set by the adapter on the child env) with workspaceRoot = process.cwd().
 */
export async function writeCapabilityPatch(opts: {
  dshHome: string;
  /** Defaults to the directory of this module (src/dsh or dist/dsh). */
  moduleDir?: string;
  role?: CapabilityRole;
}): Promise<CapabilityPatch> {
  const moduleDir = opts.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const role = opts.role ?? 'extractor';
  const researchTools = siblingSource(moduleDir, 'research-tools');
  const extractorProfile = siblingSource(moduleDir, 'extractor-profile');
  const capabilityGuard = siblingSource(moduleDir, 'capability-guard');

  // One file per role, because two harnesses in the same DSH home can be
  // mounting different contracts: the analysis adapter runs extractor-profile
  // sessions while an implementation session must keep DSH's own visibility.
  // Sharing one patch path would make the second writer silently redefine the
  // first, and the yml on disk would describe neither.
  const patchPath = join(
    opts.dshHome,
    role === 'coding' ? 'ideaseek-coding.cordis.yml' : 'ideaseek.cordis.yml',
  );

  const rows: Record<string, unknown>[] = [
    {
      insert: [
        { id: 'ideaseek-research-tools', name: researchTools },
        { id: 'ideaseek-capability-guard', name: capabilityGuard },
        ...(role === 'coding'
          ? []
          : [
              {
                id: 'ideaseek-agent-preset-registry',
                name: '@deepseek-ai/dsh-agent-preset-registry',
                config: { default: EXTRACTOR_PRESET_ID },
              },
            ]),
        ...(role === 'coding'
          ? []
          : [
              {
                id: `ideaseek-preset-${EXTRACTOR_PRESET_ID}`,
                name: '@deepseek-ai/dsh-agent-preset',
                config: {
                  id: EXTRACTOR_PRESET_ID,
                  name: 'IdeaSeek Paper Extractor',
                  description:
                    'Model-only extraction with a read-only project tool surface ' +
                    '(Phase 1 capability profile).',
                  plugins: [{ id: 'ideaseek-extractor-profile', name: extractorProfile }],
                },
              },
            ]),
      ],
    },
  ];

  const yaml = `${stringify(rows).trimEnd()}\n`;
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, yaml, 'utf8');
  return {
    patchPath,
    yaml,
    pluginPaths: { researchTools, extractorProfile, capabilityGuard },
  };
}
