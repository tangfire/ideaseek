import { describe, expect, it } from 'vitest';
import { detectEnvironment, probeCommand, probeDisk } from '../src/runtime/detect.js';

describe('environment detection', () => {
  it('probes an available binary and extracts its version', async () => {
    const probe = await probeCommand(process.execPath, ['--version']);
    expect(probe.available).toBe(true);
    expect(probe.version).toMatch(/^\d+\.\d+/);
  });

  it('reports missing binaries without throwing', async () => {
    const probe = await probeCommand('ideaseek-definitely-not-installed', ['--version']);
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('not found');
  });

  it('kills hung probes after the timeout', async () => {
    const probe = await probeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 300,
    });
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('timed out');
  }, 10_000);

  it('reads disk usage for a path', async () => {
    const disk = await probeDisk(process.cwd());
    expect(disk.totalBytes === null || disk.totalBytes > 0).toBe(true);
    if (disk.freeBytes !== null) expect(disk.freeBytes).toBeGreaterThanOrEqual(0);
  });

  it('detectEnvironment returns a full report with a supported node', async () => {
    const env = await detectEnvironment(process.cwd());
    expect(env.node.supported).toBe(true);
    expect(env.node.version).toBe(process.versions.node);
    expect(env.python.candidates).toContain('python3');
    expect(typeof env.containerRuntimes.docker.available).toBe('boolean');
    expect(Array.isArray(env.gpu.devices)).toBe(true);
    expect(env.platform.os).toBe(process.platform);
    expect(env.detectedAt).toBeGreaterThan(0);
  }, 15_000);
});
