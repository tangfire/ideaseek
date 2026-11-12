import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { action, jsonLine } from './shared.js';
import { runProcess } from '../core/proc.js';

/**
 * `ideaseek render` — reading views for IdeaSeek artifacts (Phase 4.5B,
 * ARIS render-html): the vendored pure-stdlib `render_html.py` converts
 * Markdown/JSON artifacts (wiki pages, reviews, audits, plans, novelty
 * reports, run reports) into single-file HTML views; this command only
 * collects targets and writes a nav index. Markdown/JSON stays canonical
 * — HTML is a generated view (ARIS invariant).
 */

interface RenderTarget {
  source: string;
  out: string;
  template: 'academic' | 'dashboard';
  title: string;
}

const MAX_TARGETS = 30;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function collectTargets(root: string): Promise<RenderTarget[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { listWorkspaces } = await import('../idea/workspace.js');
  const targets: RenderTarget[] = [];
  const exists = async (path: string): Promise<boolean> =>
    stat(path)
      .then((info) => info.isFile())
      .catch(() => false);

  const wikiIndex = join(root, 'knowledge', 'research-wiki', 'index.md');
  if (await exists(wikiIndex)) {
    targets.push({
      source: wikiIndex,
      out: 'wiki-index.html',
      template: 'dashboard',
      title: 'Research Wiki Index',
    });
  }
  const queryPack = join(root, 'knowledge', 'research-wiki', 'query_pack.md');
  if (await exists(queryPack)) {
    targets.push({
      source: queryPack,
      out: 'wiki-query-pack.html',
      template: 'dashboard',
      title: 'Research Wiki Query Pack',
    });
  }
  for (const dir of ['papers', 'ideas', 'experiments', 'claims']) {
    const base = join(root, 'knowledge', 'research-wiki', dir);
    for (const name of (await readdir(base).catch(() => [] as string[])).sort()) {
      if (!name.endsWith('.md')) continue;
      targets.push({
        source: join(base, name),
        out: `${dir}-${name.replace(/\.md$/, '')}.html`,
        template: 'academic',
        title: `${dir}: ${name.replace(/\.md$/, '')}`,
      });
    }
  }

  for (const idea of await listWorkspaces(root)) {
    const ideaRoot = join(root, 'ideas', idea.ideaId);
    // latest review round only (highest round number)
    const reviewsDir = join(ideaRoot, 'reviews');
    let latestRound = 0;
    for (const name of await readdir(reviewsDir).catch(() => [] as string[])) {
      const match = /^round-(\d+)\.json$/.exec(name);
      if (match) latestRound = Math.max(latestRound, Number(match[1]));
    }
    if (latestRound > 0) {
      targets.push({
        source: join(reviewsDir, `round-${latestRound}.json`),
        out: `review-${idea.ideaId}-r${latestRound}.html`,
        template: 'academic',
        title: `Independent review ${idea.ideaId} round ${latestRound}`,
      });
    }
    for (const [file, label] of [
      ['experiments/audit.json', 'Experiment audit'],
      ['experiments/plan.json', 'Experiment plan'],
      ['novelty.json', 'Novelty report'],
    ] as const) {
      const source = join(ideaRoot, file);
      if (await exists(source)) {
        targets.push({
          source,
          out: `${label.split(' ')[0]!.toLowerCase()}-${idea.ideaId}.html`,
          template: 'academic',
          title: `${label}: ${idea.ideaId}`,
        });
      }
    }
  }

  const reportsDir = join(root, 'reports');
  for (const name of (await readdir(reportsDir).catch(() => [] as string[])).sort()) {
    if (!name.endsWith('.md')) continue;
    targets.push({
      source: join(reportsDir, name),
      out: `report-${name.replace(/\.md$/, '')}.html`,
      template: 'academic',
      title: `Report ${name.replace(/\.md$/, '')}`,
    });
  }

  return targets.slice(0, MAX_TARGETS);
}

async function runRenderer(bin: string, args: string[]): Promise<{ code: number; out: string }> {
  // Shared subprocess adapter: 60s bound, tree-killed on timeout (a hung
  // helper used to block the command forever).
  try {
    const result = await runProcess(bin, args, {
      timeoutMs: 60_000,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    if (result.timedOut) {
      return { code: -1, out: 'render timed out after 60000ms (process tree killed)' };
    }
    return { code: result.code ?? -1, out: `${result.stdout}${result.stderr}` };
  } catch {
    return { code: -1, out: '' };
  }
}

export function registerRenderCommand(program: Command): void {
  program
    .command('render')
    .description(
      'render wiki/review/audit/plan/novelty/report artifacts to single-file HTML reading views',
    )
    .option('--offline', 'skip CDN assets (MathJax/highlight.js) for offline reading')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { offline?: boolean; json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const { arisSkillsRoot } = await import('../aris/skill.js');
        const { join } = await import('node:path');
        const script = join(arisSkillsRoot(), 'skills', 'render-html', 'scripts', 'render_html.py');

        const targets = await collectTargets(root);
        if (targets.length === 0) {
          if (opts.json) {
            process.stdout.write(jsonLine({ rendered: [], out: 'knowledge/render', count: 0 }));
            return 0;
          }
          process.stdout.write(
            'nothing to render yet — build the wiki (ideaseek wiki) or generate plan/review/audit reports first\n',
          );
          return 0;
        }

        const outDir = join(root, 'knowledge', 'render');
        await ensureDir(outDir);

        const bins = process.env.IDEASEEK_PYTHON
          ? [process.env.IDEASEEK_PYTHON]
          : ['python3', 'python'];
        let renderer: string | null = null;
        for (const bin of bins) {
          const probe = await runRenderer(bin, ['--help']);
          if (probe.code === 0 || /usage:/i.test(probe.out)) {
            renderer = bin;
            break;
          }
        }
        if (!renderer) {
          throw new IdeaseekError(
            'ENV_UNSUPPORTED',
            'render requires python (the vendored ARIS render_html.py is stdlib-only) — ' +
              'install python or set IDEASEEK_PYTHON',
          );
        }

        const rendered: { source: string; out: string }[] = [];
        for (const target of targets) {
          const outPath = join(outDir, target.out);
          const args = [
            script,
            target.source,
            '--template',
            target.template,
            '--out',
            outPath,
            '--title',
            target.title,
          ];
          if (opts.offline) args.push('--offline');
          const result = await runRenderer(renderer, args);
          if (result.code !== 0) {
            throw new IdeaseekError(
              'INTERNAL',
              `render failed for ${target.source}: ${result.out.slice(0, 200)}`,
            );
          }
          rendered.push({ source: target.source, out: `knowledge/render/${target.out}` });
        }

        // Nav index (generated view of generated views; sources stay canonical).
        const navRows = rendered
          .map(
            (entry) =>
              `<li><a href="${escapeHtml(entry.out.split('/').pop() ?? '')}">${escapeHtml(
                entry.out.split('/').pop() ?? entry.out,
              )}</a> <span class="src">${escapeHtml(entry.source.replace(`${root}/`, ''))}</span></li>`,
          )
          .join('\n');
        await writeFileAtomic(
          join(outDir, 'index.html'),
          `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>IdeaSeek reading views</title>
<style>
 body { font-family: Georgia, serif; margin: 2rem auto; max-width: 52rem; line-height: 1.5; color: #1c1c1c; }
 h1 { font-size: 1.4rem; }
 li { margin: .35rem 0; }
 .src { color: #777; font-size: .85em; font-family: monospace; }
 .note { color: #555; font-size: .9em; }
</style>
</head>
<body>
<h1>IdeaSeek reading views</h1>
<p class="note">Generated by ideaseek render (ARIS render-html). Markdown/JSON sources remain canonical.</p>
<ul>
${navRows}
</ul>
</body>
</html>
`,
        );

        if (opts.json) {
          process.stdout.write(
            jsonLine({ count: rendered.length, out: 'knowledge/render', rendered }),
          );
          return 0;
        }
        process.stdout.write(`rendered ${rendered.length} reading view(s) → knowledge/render/\n`);
        for (const entry of rendered) process.stdout.write(`  + ${entry.out}\n`);
        process.stdout.write('next: open knowledge/render/index.html\n');
        return 0;
      }),
    );
}
