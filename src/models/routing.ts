/**
 * Model tier routing registry (docs/MODEL_ROUTING.md). Display-only state
 * for `ideaseek models` / `/models`: which tier binds which provider/model,
 * which roles use each tier, and whether credentials EXIST — never their
 * values. Tier→model bindings default to the DSH adapter's provider/model
 * and can be overridden per environment without touching code.
 */

export type ModelTier = 'fast' | 'balanced' | 'deep' | 'deterministic';

export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'balanced', 'deep', 'deterministic'];

/** Role → tier map (MODEL_ROUTING.md 默认路由). */
export const ROLE_TIERS: Record<string, ModelTier> = {
  paper_extractor: 'fast',
  evidence_checker: 'deterministic',
  synthesis_analyst: 'balanced',
  protocol_synthesis: 'deep',
  comparison_discovery: 'balanced',
  dataset_discovery: 'balanced',
  baseline_repair: 'balanced',
  baseline_reproduction: 'deep',
  mechanism_analyst: 'deep',
  idea_generator: 'deep',
  novelty_challenger: 'deep',
  experiment_designer: 'balanced',
  code_implementer: 'balanced',
  result_analyst: 'deep',
  workflow_supervisor: 'deterministic',
};

export interface TierBinding {
  tier: ModelTier;
  provider: string | null;
  model: string | null;
  /** Environment override used (e.g. IDEASEEK_MODEL_FAST), if any. */
  overrideEnv?: string;
  roles: string[];
  capabilities: { toolCalling: string; structuredOutput: string; longContext: string };
}

function envOverride(tier: ModelTier): string | null {
  const key = `IDEASEEK_MODEL_${tier.toUpperCase()}`;
  const value = process.env[key];
  return value && value.trim() ? value.trim() : null;
}

/**
 * Current tier bindings. Deterministic tier never calls a model; the model
 * tiers default to the DSH adapter's provider/model (dsh-adapter defaults:
 * deepseek-official / deepseek-v4-flash) unless overridden by env.
 */
export function describeTierBindings(): TierBinding[] {
  const defaults: Record<
    Exclude<ModelTier, 'deterministic'>,
    { provider: string; model: string; env: string }
  > = {
    fast: { provider: 'deepseek-official', model: 'deepseek-v4-flash', env: 'IDEASEEK_MODEL_FAST' },
    balanced: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      env: 'IDEASEEK_MODEL_BALANCED',
    },
    deep: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      env: 'IDEASEEK_MODEL_DEEP',
    },
  };
  const rolesOf = (tier: ModelTier): string[] =>
    Object.entries(ROLE_TIERS)
      .filter(([, t]) => t === tier)
      .map(([role]) => role)
      .sort();

  const capabilities = (tier: ModelTier) =>
    tier === 'deterministic'
      ? {
          toolCalling: 'n/a (no model)',
          structuredOutput: 'n/a (no model)',
          longContext: 'n/a (no model)',
        }
      : {
          toolCalling: 'per-provider (not verified here)',
          structuredOutput: 'per-provider (not verified here)',
          longContext: 'per-provider (not verified here)',
        };

  return MODEL_TIERS.map((tier) => {
    if (tier === 'deterministic') {
      return {
        tier,
        provider: null,
        model: null,
        roles: rolesOf(tier),
        capabilities: capabilities(tier),
      };
    }
    const binding = defaults[tier];
    const override = envOverride(tier);
    return {
      tier,
      provider: binding.provider,
      model: override ?? binding.model,
      ...(override ? { overrideEnv: binding.env } : {}),
      roles: rolesOf(tier),
      capabilities: capabilities(tier),
    };
  });
}

export interface CredentialStatus {
  /** Presence only — values are never read into this structure. */
  deepseekApiKey: 'configured' | 'missing';
}

export function credentialStatus(): CredentialStatus {
  const value = process.env.DEEPSEEK_API_KEY;
  return { deepseekApiKey: value && value.trim() ? 'configured' : 'missing' };
}
