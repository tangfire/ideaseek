import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline';
import { detectEnvironment } from '../runtime/detect.js';
import { renderBanner, renderHeader, type HeaderContext } from './banner.js';
import { formatEventLine, paint, type PaintOptions } from './format.js';
import { cliEntryPath, runCli, runCliJson } from './runner.js';

/**
 * Interactive REPL (docs/TERMINAL_UX.md). Every slash command is a thin
 * relay over the existing non-interactive CLI — no business logic is
 * duplicated here. A background `attach --json` child replays persisted
 * RunEvents then follows live ones; quitting never cancels the run.
 */

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', usage: '/help', description: 'show this help' },
  { name: '/status', usage: '/status', description: 'run state, tasks, workers, recent events' },
  { name: '/next', usage: '/next', description: 'state-aware suggestion for the next command' },
  { name: '/papers', usage: '/papers', description: 'paper indexing progress and parse failures' },
  {
    name: '/comparisons',
    usage: '/comparisons',
    description: 'comparison methods, sources and blockers',
  },
  { name: '/ideas', usage: '/ideas', description: 'idea status and versions (Phase 5)' },
  {
    name: '/experiments',
    usage: '/experiments',
    description: 'recorded experiment specs and results',
  },
  { name: '/logs', usage: '/logs <task-id>', description: 'task detail with redacted logs' },
  { name: '/approve', usage: '/approve', description: 'confirm the pending protocol proposal' },
  {
    name: '/reject',
    usage: '/reject <reason>',
    description: 'reject the pending proposal with a reason',
  },
  { name: '/pause', usage: '/pause', description: 'stop claiming new tasks (safe pause)' },
  { name: '/resume', usage: '/resume', description: 'resume a paused run' },
  { name: '/continue', usage: '/continue', description: 'continue a run blocked on quota/auth' },
  { name: '/cancel', usage: '/cancel', description: 'cancel the run (artifacts and events kept)' },
  { name: '/report', usage: '/report', description: 'write the factual run report' },
  {
    name: '/models',
    usage: '/models',
    description: 'model tier routes, roles, credential presence',
  },
  { name: '/quit', usage: '/quit', description: 'exit the UI (background runs keep going)' },
];

/** Readline Tab completer: prefix filter over slash commands. */
export function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const matches = SLASH_COMMANDS.map((cmd) => cmd.name).filter((name) => name.startsWith(line));
  return [matches, line];
}

export type SlashResolution =
  | { kind: 'exact'; name: string }
  | { kind: 'prefix'; name: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unknown' };

/** Exact match, else unique-prefix match (e.g. `/sta` → `/status`). */
export function resolveSlash(input: string): SlashResolution {
  const names = SLASH_COMMANDS.map((cmd) => cmd.name);
  if (names.includes(input)) return { kind: 'exact', name: input };
  const candidates = names.filter((name) => name.startsWith(input));
  if (candidates.length === 1) return { kind: 'prefix', name: candidates[0]! };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'unknown' };
}

function helpText(): string {
  const lines = ['Ideaseek commands:'];
  for (const cmd of SLASH_COMMANDS) {
    lines.push(`  ${cmd.usage.padEnd(22)} ${cmd.description}`);
  }
  lines.push('');
  lines.push('Tab completes; a unique prefix works too (e.g. /sta → /status).');
  lines.push('Every command has an equivalent non-interactive CLI form.');
  return lines.join('\n');
}

interface StatusPayload {
  project: string;
  run: {
    runId: string;
    status: string;
    phase: string;
    question: string;
    blockReason: string | null;
    strategy?: string;
  } | null;
  tasks: Record<string, number>;
  total: number;
  liveWorkers: number;
  daemon?: { pid: number; state: string; logPath: string } | null;
}

interface PapersPayload {
  indexed: number;
}

async function buildHeader(plain: boolean): Promise<string> {
  const paintOpts: PaintOptions = { plain };
  const [status, papers, env] = await Promise.all([
    runCliJson<StatusPayload>(['status', '--json']).catch(() => null),
    runCliJson<PapersPayload>(['papers', '--json']).catch(() => null),
    detectEnvironment(process.cwd()).catch(() => null),
  ]);
  if (!status?.data) {
    return paint(
      'not an IdeaSeek project — run: ideaseek init (or cd into one)',
      'warn',
      paintOpts,
    );
  }
  const run = status.data.run ?? null;
  const counts = status.data?.tasks ?? {};
  const ctx: HeaderContext = {
    project: status.data?.project ?? '(unknown project)',
    question: run?.question || null,
    mode: run?.strategy ?? null,
    runId: run?.runId ?? null,
    runStatus: run?.status ?? null,
    stage: run?.phase ?? null,
    blockReason: run?.blockReason ?? null,
    agents: status.data?.liveWorkers ?? 0,
    tasks: {
      done: counts.succeeded ?? 0,
      total: status.data?.total ?? 0,
      queued: counts.queued ?? 0,
      running: (counts.leased ?? 0) + (counts.running ?? 0) + (counts.committing ?? 0),
      failed: counts.failed ?? 0,
    },
    papersIndexed: papers?.data?.indexed ?? null,
    gpu: env?.gpu.nvidiaSmi.available
      ? `${env.gpu.devices.length} device(s)${env.gpu.cudaVersion ? `, CUDA ${env.gpu.cudaVersion}` : ''}`
      : null,
    cpuCores: os.cpus().length,
    memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    supervisor: status.data.daemon
      ? `pid ${status.data.daemon.pid} ${status.data.daemon.state}`
      : null,
  };
  return paint(renderHeader(ctx), 'dim', paintOpts);
}

export interface InteractiveOptions {
  plain?: boolean;
}

interface AttachEventJson {
  seq: number;
  runId: string;
  ts: number;
  type: string;
  phase?: string;
  role?: string;
  object: string | null;
  summary: string;
  status: string | null;
}

export async function startInteractive(opts: InteractiveOptions = {}): Promise<number> {
  const plain = opts.plain === true;
  const paintOpts: PaintOptions = { plain };
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;

  const banner = renderBanner({ plain });
  process.stdout.write(`${paint(banner, 'brand', paintOpts)}\n`);
  const header = await buildHeader(plain);
  process.stdout.write(`${header}\n`);
  process.stdout.write(
    `${paint('type /help for commands · Tab completes · /quit exits (runs keep going)', 'dim', paintOpts)}\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint('ideaseek › ', 'brand', paintOpts),
    completer: slashCompleter,
  });

  let promptShown = false;
  let quitting = false;
  let streamChild: ChildProcess | null = null;

  const showPrompt = (): void => {
    rl.prompt();
    promptShown = true;
  };

  /** Writes a line above the prompt without losing the typed buffer. */
  const println = (text: string): void => {
    if (!promptShown) {
      process.stdout.write(`${text}\n`);
      return;
    }
    if (tty && !plain) {
      process.stdout.write('\r\x1b[K');
      process.stdout.write(`${text}\n`);
      rl.prompt(true);
      if (rl.line) {
        process.stdout.write(rl.line);
        const back = rl.line.length - (rl.cursor ?? rl.line.length);
        if (back > 0) process.stdout.write(`\x1b[${back}D`);
      }
      return;
    }
    // Piped / plain: orphan the old prompt line, keep output line-oriented.
    promptShown = false;
    process.stdout.write(`\n${text}\n`);
  };

  const relay = async (args: string[]): Promise<void> => {
    const result = await runCli(args, { timeoutMs: 60_000 });
    if (result.stdout) {
      const text = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
      for (const line of text.split(/\r?\n/)) println(line);
    }
    if (result.stderr) {
      const text = result.stderr.endsWith('\n') ? result.stderr.slice(0, -1) : result.stderr;
      for (const line of text.split(/\r?\n/)) println(paint(line, 'error', paintOpts));
    }
  };

  const stopStream = (): void => {
    if (streamChild) {
      streamChild.kill();
      streamChild = null;
    }
  };

  const startStream = (): void => {
    const child = spawn(process.execPath, [cliEntryPath(), 'attach', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    streamChild = child;
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as AttachEventJson;
          println(
            formatEventLine(
              {
                seq: event.seq,
                runId: event.runId,
                ts: event.ts,
                phase: event.phase ?? '',
                objectId: event.object,
                role: event.role ?? null,
                eventType: event.type,
                summary: event.summary,
                status: event.status,
                artifactRefs: [],
              },
              paintOpts,
            ),
          );
        } catch {
          // non-JSON chatter from the child — surface verbatim
          println(line);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) println(paint(`event stream: ${text}`, 'warn', paintOpts));
    });
    child.on('close', (code) => {
      streamChild = null;
      if (!quitting) {
        println(
          paint(
            `(event stream ended${code === 0 || code === null ? '' : ` exit ${code}`})`,
            'dim',
            paintOpts,
          ),
        );
      }
    });
  };

  const dispatch = async (input: string): Promise<'continue' | 'quit'> => {
    // Arguments never take part in command matching: `/reject some reason`
    // resolves on `/reject` alone.
    const spaceAt = input.search(/\s/);
    const head = spaceAt === -1 ? input : input.slice(0, spaceAt);
    const rest = spaceAt === -1 ? '' : input.slice(spaceAt).trim();
    const resolution = resolveSlash(head);
    if (resolution.kind === 'unknown') {
      println(`unknown command: ${head} — try /help (or a prefix like /sta)`);
      return 'continue';
    }
    if (resolution.kind === 'ambiguous') {
      println(`ambiguous prefix: ${head} → ${resolution.candidates.join(', ')}`);
      return 'continue';
    }
    const name = resolution.name;

    switch (name) {
      case '/help':
        println(helpText());
        return 'continue';
      case '/ideas':
        println('no ideas recorded yet — idea generation lands in Phase 5');
        return 'continue';
      case '/quit':
        return 'quit';
      case '/logs': {
        if (!rest) {
          println('usage: /logs <task-id>');
          return 'continue';
        }
        await relay(['logs', ...rest.split(/\s+/)]);
        return 'continue';
      }
      case '/reject': {
        if (!rest) {
          println('usage: /reject <reason>');
          return 'continue';
        }
        await relay(['reject', rest]);
        return 'continue';
      }
      case '/approve':
        await relay(['confirm', 'protocol', '--by', 'user']);
        return 'continue';
      case '/status':
        await relay(['status']);
        return 'continue';
      case '/next':
        await relay(['next']);
        return 'continue';
      case '/papers':
        await relay(['papers']);
        return 'continue';
      case '/comparisons':
        await relay(['comparison', 'list']);
        return 'continue';
      case '/experiments':
        await relay(['experiment', 'list']);
        return 'continue';
      case '/pause':
        await relay(['pause']);
        return 'continue';
      case '/resume':
        await relay(['resume']);
        return 'continue';
      case '/continue':
        await relay(['continue']);
        return 'continue';
      case '/cancel':
        await relay(['cancel']);
        return 'continue';
      case '/report':
        await relay(['report']);
        return 'continue';
      case '/models':
        await relay(['models']);
        return 'continue';
      default:
        println(`unknown command: ${name} — try /help`);
        return 'continue';
    }
  };

  startStream();

  return new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      if (quitting) return;
      quitting = true;
      stopStream();
      rl.close();
      resolve(code);
    };

    // Lines are processed strictly in order: a piped stdin chunk can emit
    // several 'line' events back-to-back, and /quit must never overtake an
    // in-flight command's output.
    let queue: Promise<void> = Promise.resolve();
    const processLine = async (raw: string): Promise<void> => {
      if (quitting) return;
      const input = raw.trim();
      try {
        if (!input) {
          // empty line — nothing to do
        } else if (!input.startsWith('/')) {
          println(`unknown input: ${input.slice(0, 40)} — type /help for commands`);
        } else {
          const outcome = await dispatch(input);
          if (outcome === 'quit') {
            println(
              paint('bye — background runs keep going (reconnect with ideaseek)', 'dim', paintOpts),
            );
            finish(0);
            return;
          }
        }
      } catch (error) {
        println(paint(`error: ${(error as Error).message}`, 'error', paintOpts));
      } finally {
        if (!quitting) showPrompt();
      }
    };

    rl.on('line', (raw) => {
      queue = queue.then(() => processLine(raw));
    });

    rl.on('SIGINT', () => {
      if (rl.line && rl.line.length > 0) {
        // Ctrl-C with typed input: clear the line.
        rl.write(null, { ctrl: true, name: 'u' });
        return;
      }
      println(paint('Ctrl-C: use /quit to exit (background runs keep going)', 'warn', paintOpts));
      showPrompt();
    });

    rl.on('close', () => {
      // stdin EOF (piped tests, closed terminal) — drain queued lines first.
      void queue.then(() => finish(0));
    });

    showPrompt();
  });
}
