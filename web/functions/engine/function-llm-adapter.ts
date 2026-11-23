/**
 * Function 侧 LLM 适配器：直接 HTTP 调用 DeepSeek API（OpenAI 兼容端点）。
 *
 * 与 DshAdapter 的区别：不起子进程，不依赖 node_modules，单次 fetch ≤45s。
 * 凭据来自 Function 环境（Qoder Sites Secret），不读本地文件。
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
}

export interface LlmCallResult {
  output: string;
  parsed: Record<string, unknown> | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  finishReason: string | null;
}

const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

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
  const apiKey = getApiKey();
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
  try {
    const key = (globalThis as Record<string, unknown>).__DEEPSEEK_API_KEY;
    if (typeof key === 'string' && key.length > 0) return key;
  } catch { /* ignore */ }

  try {
    const env = (globalThis as Record<string, unknown>).Deno as { env?: { get(k: string): string | undefined } } | undefined;
    const key = env?.env?.get('DEEPSEEK_API_KEY');
    if (key && key.length > 0) return key;
  } catch { /* ignore */ }

  // TODO: 临时硬编码用于测试，配置好 Qoder Sites Secret 后删除
  return 'sk-PBqt9sFeTGaXCaiSUk0RLVwdxONtRzL3ymfVefVw2i1YAzXw';
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
