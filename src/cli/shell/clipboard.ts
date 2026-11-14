import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface CopyResult {
  ok: boolean;
  reason?: string;
}

function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function clipboardCandidates(): { cmd: string; args: string[] }[] {
  if (process.platform === 'win32') return [{ cmd: 'clip', args: [] }];
  if (process.platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  if (isWsl()) return [{ cmd: 'clip.exe', args: [] }];
  return [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

function trySpawnCopy(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(cmd, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        done(false);
      }, 2000);
      child.on('error', () => {
        clearTimeout(timer);
        done(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(text);
    } catch {
      done(false);
    }
  });
}

/**
 * Best-effort copy to the host OS clipboard (Windows clip, macOS pbcopy,
 * WSL clip.exe, Linux Wayland/X11). Never throws into the TUI render loop.
 */
export async function copyToClipboard(text: string): Promise<CopyResult> {
  if (!text) return { ok: false, reason: 'nothing to copy' };
  for (const candidate of clipboardCandidates()) {
    if (await trySpawnCopy(candidate.cmd, candidate.args, text)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'no clipboard utility available' };
}
