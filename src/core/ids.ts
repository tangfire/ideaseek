import { randomUUID } from 'node:crypto';

/**
 * Generates a stable prefixed identifier, e.g. `run-1f0c...`.
 * IDs are type-branded strings so different object kinds never collide in logs
 * or foreign keys.
 */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
