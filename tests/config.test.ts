import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  configIsUsable,
  defaultConfig,
  loadConfig,
  migrateConfig,
  validateRawConfig,
} from '../src/config/config.js';
import { projectPaths } from '../src/config/paths.js';
import { IdeaseekError } from '../src/core/errors.js';
import { initInternals } from '../src/commands/init.js';

async function projectWithConfig(yaml: string | null): Promise<ReturnType<typeof projectPaths>> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-config-'));
  const paths = projectPaths(dir);
  if (yaml !== null) await writeFile(paths.configFile, yaml, 'utf8');
  return paths;
}

describe('config schema and migration', () => {
  it('falls back to defaults with all sources marked default when the file is missing', async () => {
    const paths = await projectWithConfig(null);
    const loaded = await loadConfig(paths, 'demo');
    expect(loaded.existed).toBe(false);
    expect(loaded.errors).toEqual([]);
    expect(loaded.resolved.runtime.leaseTtlSeconds).toBe(30);
    expect(loaded.sources['runtime.lease_ttl_seconds']).toBe('default');
    expect(configIsUsable(loaded)).toBe(true);
  });

  it('marks values present in the file as file-sourced and keeps defaults for the rest', async () => {
    const paths = await projectWithConfig(
      [
        'config_version: 1',
        'project:',
        '  name: custom',
        'runtime:',
        '  lease_ttl_seconds: 5',
        '',
      ].join('\n'),
    );
    const loaded = await loadConfig(paths);
    expect(loaded.errors).toEqual([]);
    expect(loaded.resolved.project.name).toBe('custom');
    expect(loaded.resolved.runtime.leaseTtlSeconds).toBe(5);
    expect(loaded.sources['project.name']).toBe('file');
    expect(loaded.sources['runtime.lease_ttl_seconds']).toBe('file');
    expect(loaded.sources['resources.max_gpu_hours']).toBe('default');
  });

  it('rejects unknown keys instead of turning them into silent defaults', async () => {
    const paths = await projectWithConfig(
      ['config_version: 1', 'project:', '  name: x', 'totally_unknown: 42', ''].join('\n'),
    );
    const loaded = await loadConfig(paths);
    expect(configIsUsable(loaded)).toBe(false);
    expect(loaded.errors.join(' ')).toContain('unknown research.yaml key: totally_unknown');
  });

  it('rejects wrong types and out-of-range enums', async () => {
    const paths = await projectWithConfig(
      [
        'config_version: 1',
        'research:',
        '  mode: banana',
        'runtime:',
        '  lease_ttl_seconds: -3',
        'resources:',
        '  max_model_tokens: -5',
        'policy:',
        '  require_all_comparisons: yes-please',
        '',
      ].join('\n'),
    );
    const loaded = await loadConfig(paths);
    expect(configIsUsable(loaded)).toBe(false);
    const text = loaded.errors.join(' | ');
    expect(text).toContain('research.mode must be one of');
    expect(text).toContain('runtime.lease_ttl_seconds must be a positive number');
    expect(text).toContain('policy.require_all_comparisons must be true or false');
    expect(text).toContain('resources.max_model_tokens must be a non-negative token count');
    // Bad values fall back so display commands still work.
    expect(loaded.resolved.runtime.leaseTtlSeconds).toBe(30);
    expect(loaded.resolved.resources.maxModelTokens).toBeNull();
  });

  it('migrates a pre-versioned file in memory and records a note', async () => {
    const paths = await projectWithConfig('project:\n  name: legacy\n');
    const loaded = await loadConfig(paths);
    expect(loaded.errors).toEqual([]);
    expect(loaded.resolved.configVersion).toBe(CONFIG_VERSION);
    expect(loaded.migrationNotes.join(' ')).toContain('no config_version');
    expect(loaded.sources['config_version']).toBe('default');
  });

  it('stops on a config_version newer than this build', async () => {
    const paths = await projectWithConfig('config_version: 99\nproject:\n  name: future\n');
    const loaded = await loadConfig(paths);
    expect(configIsUsable(loaded)).toBe(false);
    expect(loaded.errors.join(' ')).toContain('config_version 99');
    expect(loaded.errors.join(' ')).toContain('upgrade ideaseek');
  });

  it('migrateConfig stamps missing versions and rejects future ones', () => {
    const migrated = migrateConfig({ project: { name: 'x' } });
    expect(migrated.raw.config_version).toBe(CONFIG_VERSION);
    expect(migrated.notes).toHaveLength(1);

    const current = migrateConfig({ config_version: CONFIG_VERSION });
    expect(current.notes).toHaveLength(0);

    expect(() => migrateConfig({ config_version: CONFIG_VERSION + 5 })).toThrow(IdeaseekError);
  });

  it('validateRawConfig flags structural problems only', () => {
    expect(validateRawConfig(undefined)).toEqual([]);
    expect(validateRawConfig([1, 2])).toEqual([
      'research.yaml must contain a mapping at the top level',
    ]);
    expect(validateRawConfig({ project: 'nope' })).toEqual(['project must be a mapping']);
    expect(validateRawConfig({ project: { name: 'ok' } })).toEqual([]);
  });

  it('the init template passes its own validation', async () => {
    const paths = await projectWithConfig(initInternals.researchYaml('template-test'));
    const loaded = await loadConfig(paths);
    expect(loaded.errors).toEqual([]);
    expect(configIsUsable(loaded)).toBe(true);
    expect(loaded.resolved).toMatchObject(defaultConfig('template-test'));
  });
});
