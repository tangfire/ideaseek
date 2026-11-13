/**
 * Image-input capability for a routed model (Phase 2 vision slice).
 *
 * Truth sources, in precedence order — never inferred from marketing
 * names (docs/MODEL_ROUTING.md 图像输入能力):
 *  1. explicit route declaration in IdeaSeek routing config (a deployment
 *     decision, recorded and auditable);
 *  2. the pinned DSH catalog facts (runtime-lock commit): DSH's
 *     llm-deepseek DEFAULT_MODELS declares
 *     `deepseek-flash: ['text','image']`, `deepseek-v4-pro: ['text']`,
 *     and DSH treats ANY uncatalogued model id as text-only — we mirror
 *     that exact rule instead of guessing;
 *  3. otherwise text-only.
 *
 * Runtime backstop: the DSH provider refuses image blocks for text-only
 * models with a typed failure (llm-deepseek images.ts admission) —
 * callers degrade on that error and never crash the workflow.
 */

export type ImageCapabilityBasis =
  'route-declaration' | 'pinned-dsh-catalog' | 'uncatalogued-text-only' | 'declared-text-only';

export interface ImageCapability {
  supported: boolean;
  basis: ImageCapabilityBasis;
  /** Human-readable provenance for `models` output and analysis reports. */
  detail: string;
}

/**
 * Catalog facts read from DSH `DEFAULT_MODELS` at the pinned commit
 * (runtime-lock.json). Keep in sync when the DSH pin moves — verified by
 * tests/image-capability.test.ts expectations below.
 */
const PINNED_DSH_CATALOG: Record<string, readonly ('text' | 'image')[]> = {
  'deepseek-flash': ['text', 'image'],
  'deepseek-v4-pro': ['text'],
};

export interface ImageCapabilityQuery {
  /** Exact routed model id (the id DSH receives). */
  model: string;
  provider?: string;
  /**
   * Explicit deployment declaration from IdeaSeek routing config
   * (TierBinding.imageInput). When present it wins — it is a recorded
   * decision, not a name-based guess.
   */
  declaredImageInput?: boolean;
}

export function resolveImageCapability(query: ImageCapabilityQuery): ImageCapability {
  if (query.declaredImageInput === true) {
    return {
      supported: true,
      basis: 'route-declaration',
      detail: 'imageInput: true declared in IdeaSeek model routing',
    };
  }
  if (query.declaredImageInput === false) {
    return {
      supported: false,
      basis: 'declared-text-only',
      detail: 'imageInput: false declared in IdeaSeek model routing',
    };
  }
  const modalities = PINNED_DSH_CATALOG[query.model];
  if (modalities) {
    return {
      supported: modalities.includes('image'),
      basis: 'pinned-dsh-catalog',
      detail: `pinned DSH catalog: ${query.model} accepts ${modalities.join('+')}`,
    };
  }
  return {
    supported: false,
    basis: 'uncatalogued-text-only',
    detail:
      `${query.model} is not in the pinned DSH catalog — DSH treats uncatalogued models as text-only ` +
      '(declare imageInput in routing to override with a verified deployment fact)',
  };
}
