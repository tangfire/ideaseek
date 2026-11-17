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

describe('pip index url from the configuration layer', () => {
  it('uses the configured mirror when the environment says nothing', () => {
    // The point of #7: an environment variable cannot be reviewed, versioned or
    // audited alongside the project it points at, and a fresh clone behaves
    // differently depending on whatever the shell happened to export. The value
    // belongs in runtime.pip_index_url, with the environment kept as an
    // override so an operator can point a single run elsewhere without editing
    // a committed file.
    expect(pipMirrorEnv(undefined, 'https://mirrors.aliyun.com/pypi/simple/')).toEqual({
      PIP_INDEX_URL: 'https://mirrors.aliyun.com/pypi/simple/',
    });
    expect(pipMirrorEnv('', 'https://mirror.example/simple/')).toEqual({
      PIP_INDEX_URL: 'https://mirror.example/simple/',
    });
  });

  it('lets the environment override a committed value, and validates either', () => {
    expect(
      pipMirrorEnv('https://from-env.example/simple/', 'https://from-config.example/simple/'),
    ).toEqual({ PIP_INDEX_URL: 'https://from-env.example/simple/' });
    // A configured mirror is held to the same rules as an env one: http,
    // credentials and non-URLs are dropped, never honoured.
    expect(pipMirrorEnv(undefined, 'http://mirror.example/simple/')).toBeUndefined();
    expect(pipMirrorEnv(undefined, 'https://u:p@mirror.example/simple/')).toBeUndefined();
    expect(pipMirrorEnv(undefined, 'not a url')).toBeUndefined();
  });
});
