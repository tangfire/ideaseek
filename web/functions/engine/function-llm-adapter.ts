/**
 * Function 侧 LLM 适配器：直接 HTTP 调用 DeepSeek API（OpenAI 兼容端点）。
 *
 * 与 DshAdapter 的区别：不起子进程，不依赖 node_modules，单次 fetch ≤45s。
 * 凭据：显式注入 / Deno.env 优先，均未设置时落回写死的官方渠道 Key（演示用）。
 *
 * 提示词组装沿用 dsh-adapter.ts 的 composeInput 契约：
 *   instruction + ## Inputs + ## Output contract → 要求纯 JSON 返回
 */

export interface LlmCallInput {
  instruction: string;
  inputs: Array<{ name: string; content: string }>;
  outputSchema: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  apiKey?: string;
}

export interface LlmCallResult {
  output: string;
  parsed: Record<string, unknown> | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  finishReason: string | null;
}

// DeepSeek 官方渠道（api.deepseek.com 与 /v1 等价），模型名即 /v1/models 列出的 id。
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 写死的 API Key（DeepSeek 官方渠道）
const HARDCODED_API_KEY = 'sk-58db45c345854831a2fb31ac8859080e';

function composePrompt(input: LlmCallInput): string {
  const parts: string[] = [input.instruction];

  if (input.inputs.length > 0) {
    parts.push('\n## Inputs');
    for (const fragment of input.inputs) {
      parts.push(`\n### ${fragment.name}\n${fragment.content}`);
    }
  }

  parts.push(`\n## Output contract`);
  parts.push(`Schema: ${input.outputSchema}`);
  parts.push('Return ONLY a valid JSON object matching this schema. No markdown fences, no commentary.');

  return parts.join('\n');
}

function extractJson(text: string): Record<string, unknown> | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1]!.trim() : text.trim();

  const braceStart = candidate.indexOf('{');
  const braceEnd = candidate.lastIndexOf('}');
  if (braceStart < 0 || braceEnd <= braceStart) return null;

  try {
    return JSON.parse(candidate.slice(braceStart, braceEnd + 1));
  } catch {
    return null;
  }
}

export async function callLlm(input: LlmCallInput): Promise<LlmCallResult> {
  const apiKey = input.apiKey ?? getApiKey();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured');

  const model = input.model ?? DEFAULT_MODEL;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 55_000);
  const prompt = composePrompt(input);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a research workflow assistant. Always respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new LlmAuthError(`API auth failed: ${status}`);
      }
      if (status === 429) {
        throw new LlmQuotaError('Rate limit exceeded');
      }
      const body = await response.text().catch(() => '');
      throw new Error(`LLM API error ${status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const finishReason = data.choices?.[0]?.finish_reason ?? null;

    return {
      output: content,
      parsed: extractJson(content),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      model: data.model ?? model,
      finishReason,
    };
  } finally {
    clearTimeout(timer);
  }
}

function getApiKey(): string | null {
  // 显式注入优先：setApiKey('') 表示"明确没有 Key"，必须抛错而不是落回写死值。
  const injected = (globalThis as Record<string, unknown>).__DEEPSEEK_API_KEY;
  if (typeof injected === 'string') return injected.length > 0 ? injected : null;

  try {
    const env = (globalThis as Record<string, unknown>).Deno as { env?: { get(k: string): string | undefined } } | undefined;
    const key = env?.env?.get('DEEPSEEK_API_KEY');
    if (key && key.length > 0) return key;
  } catch { /* ignore */ }

  return HARDCODED_API_KEY.length > 0 ? HARDCODED_API_KEY : null;
}

export function setApiKey(key: string): void {
  (globalThis as Record<string, unknown>).__DEEPSEEK_API_KEY = key;
}

export class LlmAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmAuthError';
  }
}

export class LlmQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmQuotaError';
  }
}

export { extractJson, composePrompt };
