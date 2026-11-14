import { describe, expect, it } from 'vitest';
import { pipMirrorEnv } from '../src/comparison/repair.js';

/**
 * The install mirror is operator infrastructure, not something an agent may
 * choose: `--index-url` inside a requirement spec is rejected by the grammar
 * precisely because that would let an inferred package list redirect every
 * install on the machine. So the value arrives from the environment and is
 * dropped rather than trusted when it does not look safe.
 */
describe('pipMirrorEnv', () => {
  it('passes an https mirror through as the variable pip already reads', () => {
    expect(pipMirrorEnv('https://mirrors.aliyun.com/pypi/simple/')).toEqual({
      PIP_INDEX_URL: 'https://mirrors.aliyun.com/pypi/simple/',
    });
  });

  it('stays out of the way when nothing is configured', () => {
    expect(pipMirrorEnv('')).toBeUndefined();
    expect(pipMirrorEnv(undefined)).toBeUndefined();
    expect(pipMirrorEnv('   ')).toBeUndefined();
  });

  it('drops a plaintext mirror instead of silently using it', () => {
    expect(pipMirrorEnv('http://mirrors.internal/pypi/simple/')).toBeUndefined();
  });

  it('drops a mirror carrying credentials', () => {
    expect(pipMirrorEnv('https://user:token@host.example/pypi/simple/')).toBeUndefined();
  });

  it('drops something that is not a URL at all', () => {
    expect(pipMirrorEnv('mirrors.aliyun.com')).toBeUndefined();
    expect(pipMirrorEnv('--index-url https://evil.example')).toBeUndefined();
  });
});
