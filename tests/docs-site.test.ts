import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Docs site pipeline (PROGRESS 231): version stamp, search index,
 * config-key table generated from `config explain --json` (schema
 * authority), and CLI-mention sync against the real built CLI. Tests run
 * against temp copies — the committed site is only read, never mutated.
 */

function run(
  args: string[],
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'scripts', 'docs-site.mjs'), ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env },
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docs-site ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('docs-site build/check pipeline', () => {
  it('check passes against the committed site (version, index, config keys, CLI sync)', async () => {
    const result = await run(['check']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('docs-site check OK');
    expect(result.stdout).toContain('CLI mention(s) verified');
    // Generated artifacts are committed for the static host.
    expect(existsSync(join(process.cwd(), 'docs', 'site', 'search-index.json'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'docs', 'site', 'config-keys.json'))).toBe(true);
    const html = await readFile(join(process.cwd(), 'docs', 'site', 'index.html'), 'utf8');
    expect(html).toMatch(/<span data-site-version>v\d+\.\d+\.\d+[^<]*<\/span>/);
  }, 180_000);

  it('build to a temp dir emits versioned page + search index + config keys', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ideaseek-site-'));
    const result = await run(['build', '--out', out]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('docs-site build:');

    const html = await readFile(join(out, 'index.html'), 'utf8');
    expect(html).toContain('data-site-version');
    const search = JSON.parse(await readFile(join(out, 'search-index.json'), 'utf8')) as {
      contract: string;
      sections: { id: string; title: string }[];
    };
    expect(search.contract).toBe('docs-search-v1');
    expect(search.sections.length).toBeGreaterThanOrEqual(7);
    expect(search.sections.map((s) => s.id)).toContain('recovery');

    const keys = JSON.parse(await readFile(join(out, 'config-keys.json'), 'utf8')) as {
      contract: string;
      keys: string[];
    };
    expect(keys.contract).toBe('docs-config-keys-v1');
    expect(keys.keys.length).toBeGreaterThan(10);
    expect(keys.keys.join(' ')).toMatch(/research|runtime|resources/);
  }, 180_000);

  it('fails on CLI drift (manual mentions a command the CLI does not have)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-site-drift-'));
    const htmlPath = join(dir, 'index.html');
    copyFileSync(join(process.cwd(), 'docs', 'site', 'index.html'), htmlPath);
    const html = await readFile(htmlPath, 'utf8');
    await writeFile(
      htmlPath,
      `${html.replace('</main>', '<p>ideaseek totally-bogus-command</p></main>')}`,
      'utf8',
    );
    const result = await run(['check', '--html', htmlPath, '--out', dir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('totally-bogus-command');
  }, 180_000);

  it('fails when generated artifacts are stale (missing index)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-site-stale-'));
    const htmlPath = join(dir, 'index.html');
    copyFileSync(join(process.cwd(), 'docs', 'site', 'index.html'), htmlPath);
    const result = await run(['check', '--html', htmlPath, '--out', dir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('stale');
  }, 180_000);
});
