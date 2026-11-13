/**
 * ADR-001: the DSH SDK stays in the adapter layer. `normalizeApiKey` is
 * the pinned dsh-llm's own key-shape authority — re-exported here so
 * application modules (models setup) validate keys without importing
 * @deepseek-ai directly.
 */
export { normalizeApiKey } from '@deepseek-ai/dsh-llm';
