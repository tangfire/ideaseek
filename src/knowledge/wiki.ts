import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { arisSkillsRoot } from '../aris/skill.js';

/**
 * Research wiki (Phase 4.5B, ARIS research-wiki): a persistent per-project
 * knowledge graph compiled from IdeaSeek's OWN state — indexed papers,
 * idea workspaces, experiment registry and plan claims — materialized in
 * the ARIS wiki layout (node pages + graph/edges.jsonl with typed edges
 * and evidence). Derived files (index.md, query_pack.md, Connections) are
 * produced by the vendored `research_wiki.py` helper (genuine reuse);
 * when python is unavailable the build degrades honestly and keeps the
 * pages/edges the helper would not have touched.
 *
 * Extraction is deterministic (ADR-003): no model, no invented edges —
 * every edge cites the artifact it came from.
 */

export const WIKI_SCHEMA = 'research-wiki-v1';

export type WikiEdgeType =
  'cites' | 'tested_by' | 'states' | 'supports' | 'contradicts' | 'extends' | 'compares';

export interface WikiNodePage {
  id: string;
  kind: 'paper' | 'idea' | 'experiment' | 'claim';
  relPath: string;
  body: string;
}

export interface WikiEdge {
  from: string;
  to: string;
  type: WikiEdgeType;
  evidence: string;
}

export interface WikiBuildResult {
  root: string;
  nodes: number;
  edges: number;
  pages: string[];
  /** 'ok' when the ARIS helper ran; 'skipped:<reason>' degrades honestly. */
  helper: string;
  stats: string[];
}

function sanitizeSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'node'
  );
}

function frontmatter(fields: Record<string, string>): string {
  const lines = ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---'];
  return lines.join('\n');
}

export interface WikiOptions {
  /** Skip the python helper materialization (tests, minimal environments). */
  helper?: boolean;
  now?: number;
}

export async function buildResearchWiki(
  root: string,
  opts: WikiOptions = {},
): Promise<WikiBuildResult> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const { listWorkspaces, loadIdeaCard } = await import('../idea/workspace.js');
  const { readPlan } = await import('../idea/plan.js');

  const now = opts.now ?? Date.now();
  const added = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const wikiRoot = join(root, 'knowledge', 'research-wiki');

  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  const pages: WikiNodePage[] = [];
  const edges: WikiEdge[] = [];
  try {
    // --- papers (indexed PaperCard sources).
    const paperSlugByKey = new Map<string, string>();
    for (const paper of await runtime.db.listIndexedPapers()) {
      const base = sanitizeSlug(basename(paper.source));
      const slug = paperSlugByKey.has(base) ? `${base}-${paper.paperKey.slice(7, 13)}` : base;
      paperSlugByKey.set(paper.paperKey, slug);
      let thesis = `Indexed from ${paper.source} (${paper.pageCount} page(s)).`;
      try {
        const payload = JSON.parse(
          await runtime.store.readFinalText(paper.paperKey as `sha256:${string}`),
        ) as {
          pages?: { page: number; text: string }[];
        };
        const first = payload.pages?.[0]?.text?.replace(/\s+/g, ' ').trim();
        if (first) thesis = `${first.slice(0, 180)}${first.length > 180 ? '…' : ''}`;
      } catch {
        // payload unreadable → the scaffold thesis above stays (honest).
      }
      pages.push({
        id: `paper:${slug}`,
        kind: 'paper',
        relPath: `papers/${slug}.md`,
        body: [
          frontmatter({
            type: 'paper',
            node_id: `paper:${slug}`,
            title: `"${basename(paper.source).replace(/"/g, '')}"`,
            authors: '[]',
            year: 'null',
            venue: 'null',
            external_ids: '{ arxiv: null, doi: null, s2: null }',
            tags: '[]',
            added,
          }),
          '',
          `# ${basename(paper.source)}`,
          '',
          '## One-line thesis',
          thesis,
          '',
          '## Problem / Gap',
          '',
          '## Method',
          '',
          '## Key Results',
          '',
          '## Assumptions',
          '',
          '## Limitations / Failure Modes',
          '',
          '## Reusable Ingredients',
          '',
          '## Open Questions',
          '',
          '## Claims',
          '',
        ].join('\n'),
      });
    }

    // --- ideas + experiments + plan claims.
    const workspaces = await listWorkspaces(root);
    for (const meta of workspaces) {
      const ideaId = meta.ideaId;
      const card = await loadIdeaCard(root, ideaId);
      pages.push({
        id: `idea:${ideaId}`,
        kind: 'idea',
        relPath: `ideas/${ideaId}.md`,
        body: [
          frontmatter({
            type: 'idea',
            node_id: `idea:${ideaId}`,
            title: `"${card.hypothesis.statement.replace(/"/g, '')}"`,
            status: meta.status,
            ...(meta.status === 'REJECTED' ? { outcome: 'negative' } : {}),
            added,
          }),
          '',
          `# ${ideaId}`,
          '',
          '## Hypothesis',
          card.hypothesis.statement,
          '',
          '## Status',
          meta.status,
          '',
          '## Experiments',
          '',
          '## Claims',
          '',
        ].join('\n'),
      });

      for (const evidence of card.paperEvidence) {
        const match = [...paperSlugByKey.entries()].find(
          ([key, slug]) =>
            key === evidence.paperRef ||
            slug === sanitizeSlug(evidence.paperRef) ||
            evidence.paperRef.includes(slug),
        );
        if (match) {
          edges.push({
            from: `idea:${ideaId}`,
            to: `paper:${match[1]}`,
            type: 'cites',
            evidence: `card.paperEvidence: ${evidence.statement.slice(0, 120)}`,
          });
        }
      }

      const plan = await readPlan(root, ideaId);
      if (plan) {
        for (const [index, claim] of plan.claimMap.entries()) {
          const slug = `${sanitizeSlug(ideaId)}-c${index + 1}`;
          pages.push({
            id: `claim:${slug}`,
            kind: 'claim',
            relPath: `claims/${slug}.md`,
            body: [
              frontmatter({
                type: 'claim',
                node_id: `claim:${slug}`,
                name: `"${claim.claim.replace(/"/g, '')}"`,
                status: 'planned',
                added,
              }),
              '',
              `# ${claim.claim}`,
              '',
              '## Statement',
              claim.claim,
              '',
              '## Evidence',
              claim.evidence,
              '',
            ].join('\n'),
          });
          edges.push({
            from: `idea:${ideaId}`,
            to: `claim:${slug}`,
            type: 'states',
            evidence: `plan.claimMap[${index}]: ${claim.evidence.slice(0, 120)}`,
          });
        }
      }
    }

    const experiments = await runtime.db.listExperiments();
    for (const doc of experiments) {
      const match = /^idea-([a-z0-9-]+?)(?:-abl-[a-z0-9-]+)?$/.exec(doc.specId);
      if (!match) continue;
      const ideaId = match[1]!;
      const spec = doc.spec as { metrics?: { name: string }[] };
      const result = doc.result as {
        status?: string;
        metrics?: { name: string; value: number }[];
      } | null;
      pages.push({
        id: `experiment:${doc.specId}`,
        kind: 'experiment',
        relPath: `experiments/${doc.specId}.md`,
        body: [
          frontmatter({
            type: 'experiment',
            node_id: `experiment:${doc.specId}`,
            title: `"${doc.specId}"`,
            status: doc.status,
            added,
          }),
          '',
          `# ${doc.specId}`,
          '',
          '## Result',
          result?.status
            ? `${result.status}${
                result.metrics?.length
                  ? ` — ${result.metrics.map((metric) => `${metric.name}=${metric.value}`).join(', ')}`
                  : ''
              }`
            : 'not run yet',
          '',
          '## Metrics',
          (spec.metrics ?? []).map((metric) => `- ${metric.name}`).join('\n'),
          '',
        ].join('\n'),
      });
      edges.push({
        from: `idea:${ideaId}`,
        to: `experiment:${doc.specId}`,
        type: 'tested_by',
        evidence: `registry ${doc.specId} v${doc.version} status=${doc.status}`,
      });
    }
  } finally {
    await runtime.close();
  }

  // --- ARIS helper init FIRST (canonical flow: skeleton + gap_map + log),
  // then our pages/edges overwrite, then the helper derives index/query_pack.
  const helperEnabled = opts.helper !== false && process.env.IDEASEEK_WIKI_SKIP_HELPER !== '1';
  const script = join(arisSkillsRoot(), 'tools', 'research_wiki.py');
  let helper = 'skipped:disabled';
  let helperBin: string | null = null;
  if (helperEnabled) {
    try {
      await readFile(script, 'utf8');
      const bins = process.env.IDEASEEK_PYTHON
        ? [process.env.IDEASEEK_PYTHON]
        : ['python3', 'python'];
      for (const bin of bins) {
        const init = await runHelper(bin, script, ['init', wikiRoot]);
        if (init && init.code === 0) {
          helperBin = bin;
          helper = 'ok';
          break;
        }
      }
      if (!helperBin) helper = 'skipped:python-unavailable';
    } catch {
      helper = 'skipped:helper-missing';
    }
  }

  // --- materialize: pages + edges + log (our writer; full rebuild = overwrite).
  for (const dir of ['papers', 'ideas', 'experiments', 'claims', 'graph']) {
    await ensureDir(join(wikiRoot, dir));
  }
  const written: string[] = [];
  for (const page of pages) {
    const path = join(wikiRoot, page.relPath);
    await writeFileAtomic(path, `${page.body}\n`);
    written.push(page.relPath);
  }
  const edgeLines = edges.map((edge) =>
    JSON.stringify({ ...edge, added: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') }),
  );
  const edgesPath = join(wikiRoot, 'graph', 'edges.jsonl');
  await writeFileAtomic(edgesPath, edgeLines.length > 0 ? `${edgeLines.join('\n')}\n` : '');
  written.push('graph/edges.jsonl');

  const logPath = join(wikiRoot, 'log.md');
  const logLine = `- \`${added}\` wiki build: ${pages.length} node(s), ${edges.length} edge(s) (ideaseek)\n`;
  try {
    const existing = await readFile(logPath, 'utf8');
    await writeFile(logPath, `${existing}${logLine}`, 'utf8');
  } catch {
    await writeFile(logPath, `# Wiki log\n${logLine}`, 'utf8');
  }

  // --- derived files (index, query_pack, stats) via the vendored helper.
  // index+pack define success; stats is cosmetic and best-effort (it prints
  // emoji that some Windows codepages refuse — utf-8 mode set in runHelper).
  const stats: string[] = [];
  if (helperBin) {
    const index = await runHelper(helperBin, script, ['rebuild_index', wikiRoot]);
    const pack =
      index && index.code === 0
        ? await runHelper(helperBin, script, ['rebuild_query_pack', wikiRoot])
        : null;
    if (!pack || pack.code !== 0) {
      helper = 'skipped:derive-failed';
    } else {
      const statOut = await runHelper(helperBin, script, ['stats', wikiRoot]);
      if (statOut && statOut.code === 0) {
        stats.push(...statOut.out.split(/\r?\n/).filter((line) => line.trim()));
      }
    }
  }

  return {
    root: wikiRoot,
    nodes: pages.length,
    edges: edges.length,
    pages: written,
    helper,
    stats,
  };
}

/** Runs the helper; null when the interpreter cannot even spawn. */
async function runHelper(
  bin: string,
  script: string,
  args: string[],
): Promise<{ code: number; out: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Force utf-8: the helper prints emoji that GBK/latin-1 stdout
      // encodings reject on Windows (UnicodeEncodeError → exit 1).
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (out += String(chunk)));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}
