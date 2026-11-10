import { describe, expect, it } from 'vitest';
import { capabilityDecision } from '../src/dsh-plugins/capability-guard.js';

describe('capabilityDecision (tools/pre-execute guard)', () => {
  it('allows exactly the research tools', () => {
    expect(capabilityDecision('project_read')).toEqual({ kind: 'allow' });
    expect(capabilityDecision('knowledge_search')).toEqual({ kind: 'allow' });
  });

  it('denies base-profile and privileged tools with an auditable reason', () => {
    for (const tool of ['read', 'grep', 'glob', 'bash', 'write', 'edit', 'str_replace_editor']) {
      const decision = capabilityDecision(tool);
      expect(decision.kind).toBe('deny');
      if (decision.kind === 'deny') {
        expect(decision.reason).toContain(tool);
        expect(decision.reason).toContain('capability profile');
        expect(decision.reason).toContain('project_read');
      }
    }
  });

  it('supports role-specific allowlists', () => {
    const role = new Set(['project_read']);
    expect(capabilityDecision('knowledge_search', role).kind).toBe('deny');
    expect(capabilityDecision('project_read', role).kind).toBe('allow');
  });

  it('is wired into the generated capability patch', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../src/dsh-plugins/capability-guard.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("ctx.on('tools/pre-execute'");
    expect(source).toContain("kind: 'deny'");
    const capability = readFileSync(
      fileURLToPath(new URL('../src/dsh/capability.ts', import.meta.url)),
      'utf8',
    );
    expect(capability).toContain('capability-guard');
    expect(capability).toContain('ideaseek-capability-guard');
  });
});
