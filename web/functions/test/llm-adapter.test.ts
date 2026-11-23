/**
 * FunctionLlmAdapter 单元测试：提示词组装、JSON 提取、错误映射。
 *
 * 跑法：npx vitest run web/functions/test/llm-adapter.test.ts --config vitest.fn.config.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composePrompt, extractJson, callLlm, setApiKey, LlmAuthError, LlmQuotaError } from '../engine/function-llm-adapter.ts';

test('composePrompt 组装 instruction + inputs + output contract', () => {
  const prompt = composePrompt({
    instruction: 'Analyze this paper',
    inputs: [
      { name: 'Abstract', content: 'This paper proposes...' },
      { name: 'Methods', content: 'We use...' },
    ],
    outputSchema: 'papercard-v1',
  });

  assert.ok(prompt.includes('Analyze this paper'));
  assert.ok(prompt.includes('## Inputs'));
  assert.ok(prompt.includes('### Abstract'));
  assert.ok(prompt.includes('This paper proposes...'));
  assert.ok(prompt.includes('### Methods'));
  assert.ok(prompt.includes('## Output contract'));
  assert.ok(prompt.includes('papercard-v1'));
  assert.ok(prompt.includes('Return ONLY a valid JSON'));
});

test('extractJson 从纯 JSON 提取', () => {
  const result = extractJson('{"title": "Test", "claims": []}');
  assert.deepEqual(result, { title: 'Test', claims: [] });
});

test('extractJson 从 markdown 代码块提取', () => {
  const result = extractJson('Here is the result:\n```json\n{"title": "Test"}\n```\nDone.');
  assert.deepEqual(result, { title: 'Test' });
});

test('extractJson 从混合文本提取', () => {
  const result = extractJson('Some preamble text\n{"key": "value"}\nSome postamble');
  assert.deepEqual(result, { key: 'value' });
});

test('extractJson 无效 JSON 返回 null', () => {
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('{broken'), null);
});

test('callLlm 缺 API key 抛错', async () => {
  setApiKey('');
  await assert.rejects(
    () => callLlm({ instruction: 'test', inputs: [], outputSchema: 'test' }),
    (err: Error) => {
      assert.ok(err.message.includes('DEEPSEEK_API_KEY'));
      return true;
    },
  );
});

test('callLlm 401 响应映射为 LlmAuthError', async () => {
  setApiKey('bad-key');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch;

  try {
    await assert.rejects(
      () => callLlm({ instruction: 'test', inputs: [], outputSchema: 'test' }),
      (err: Error) => {
        assert.ok(err instanceof LlmAuthError);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callLlm 429 响应映射为 LlmQuotaError', async () => {
  setApiKey('test-key');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('Rate limited', { status: 429 })) as typeof fetch;

  try {
    await assert.rejects(
      () => callLlm({ instruction: 'test', inputs: [], outputSchema: 'test' }),
      (err: Error) => {
        assert.ok(err instanceof LlmQuotaError);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('callLlm 正常响应解析 usage 和 model', async () => {
  setApiKey('test-key');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"result": 42}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
    model: 'deepseek-chat',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

  try {
    const result = await callLlm({ instruction: 'test', inputs: [], outputSchema: 'test' });
    assert.deepEqual(result.parsed, { result: 42 });
    assert.equal(result.model, 'deepseek-chat');
    assert.equal(result.usage.inputTokens, 50);
    assert.equal(result.usage.outputTokens, 10);
    assert.equal(result.finishReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
