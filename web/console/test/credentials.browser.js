async (page) => {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let mode = 'fail';
  let listFails = false;
  let revoked = false;
  let creates = 0;
  let deletes = 0;
  let release;
  await page.route('**/functions/v1/app/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let body;
    if (path.endsWith('/auth/me')) body = { ok: true, username: 'reviewer', owner_id: 'owner' };
    else if (path.endsWith('/views/project'))
      body = {
        ok: true,
        projection_level: 'full',
        writable: true,
        visibility: 'private',
        project: {
          external_id: 'credentials',
          title: '凭据反馈测试',
          question: '问题',
          strategy: 'standard',
          autonomy: 'guided',
          last_sync_at: null,
        },
        runs: [],
        stages: [],
        papers: [],
        ideas: [],
        experiments: [],
        claims: [],
        protocols: [],
        events: [],
        unsynced: null,
      };
    else if (path.endsWith('/views/approvals')) body = { ok: true, approvals: [] };
    else if (path.endsWith('/views/costs'))
      body = {
        ok: true,
        runs: [],
        summary: { total_usd_micro: 0, total_tokens_in: 0, total_tokens_out: 0, by_route: {} },
      };
    else if (path.endsWith('/views/egress')) body = { ok: true, runs: [] };
    else if (path.endsWith('/views/health')) body = { ok: true, projection_level: 'full', health: { latest_batch: null, pending_batches: 0, rejected_reason_distribution: {} } };
    else if (path.endsWith('/views/tokens') && req.method() === 'GET') {
      if (listFails) {
        await route.fulfill({ status: 503, json: { ok: false } });
        return;
      }
      body = {
        ok: true,
        tokens: [
          {
            id: 'test-credential',
            label: '本地测试凭据',
            scopes: ['sync'],
            project_scope: [],
            created_at: '2026-11-25T00:00:00Z',
            last_used_at: null,
            revoked_at: revoked ? '2026-11-25T01:00:00Z' : null,
          },
        ],
      };
    } else if (
      (path.endsWith('/views/tokens') && req.method() === 'POST') ||
      (path.endsWith('/views/tokens/test-credential') && req.method() === 'DELETE')
    ) {
      if (req.method() === 'POST') creates++;
      else deletes++;
      if (mode === 'hold')
        await new Promise((resolve) => {
          release = resolve;
        });
      if (mode === 'fail') {
        await route.fulfill({
          status: 503,
          json: { ok: false, message: 'internal-do-not-display' },
        });
        return;
      }
      if (req.method() === 'DELETE') {
        revoked = true;
        body = { ok: true };
      } else
        body =
          mode === 'malformed'
            ? { ok: true }
            : { ok: true, plain_token: 'test-only-token', message: 'ok' };
    } else if (path.endsWith('/live')) body = { frames: [] };
    else throw new Error(`未声明的测试请求：${path}`);
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/p/credentials');
  await page.getByRole('tab', { name: '审计', exact: true }).click();
  const create = page.getByRole('button', { name: '签发新 Token', exact: true });
  await create.waitFor();
  await create.click();
  await page.getByRole('alert').filter({ hasText: '签发未确认：' }).waitFor();
  check(
    !(await page.locator('body').innerText()).includes('internal-do-not-display'),
    '显示了未脱敏的服务错误',
  );
  check(
    (await page.locator('code').filter({ hasText: 'test-only' }).count()) === 0,
    '失败后伪造凭据',
  );
  mode = 'malformed';
  await create.click();
  await page.getByRole('alert').filter({ hasText: '服务未返回可保存的同步凭据' }).waitFor();
  mode = 'hold';
  await create.click();
  await page.waitForFunction(() => document.querySelector('button.btn-primary:disabled'));
  check(
    (await create.isDisabled()) &&
      (await page.getByRole('button', { name: '吊销', exact: true }).isDisabled()),
    '签发等待中允许并发写入',
  );
  check(creates === 3, '签发次数异常');
  release();
  await page.getByText('请立即保存此 token，关闭页面后将无法再次查看：', { exact: true }).waitFor();
  check((await page.getByRole('alert').count()) === 0, '成功后保留旧签发错误');
  await page.evaluate(() => {
    window.confirm = () => false;
  });
  await page.getByRole('button', { name: '吊销', exact: true }).click();
  check(deletes === 0, '取消确认仍发出吊销');
  mode = 'fail';
  await page.evaluate(() => {
    window.confirm = () => true;
  });
  await page.getByRole('button', { name: '吊销', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '吊销未确认：' }).waitFor();
  check((await page.getByText('已吊销', { exact: true }).count()) === 0, '失败吊销被显示为成功');
  mode = 'hold';
  await page.getByRole('button', { name: '吊销', exact: true }).click();
  await page.getByRole('button', { name: '吊销中…', exact: true }).waitFor();
  check(await create.isDisabled(), '吊销等待中可以签发');
  release();
  await page.getByText('已吊销', { exact: true }).waitFor();
  await page.getByRole('status').filter({ hasText: '同步凭据已吊销。' }).waitFor();
  check((await page.getByRole('alert').count()) === 0, '成功后保留旧吊销错误');
  listFails = true;
  await page.getByRole('button', { name: '刷新凭据列表', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '凭据列表读取失败' }).waitFor();
  check(await create.isDisabled(), '列表失败时仍允许签发');
  listFails = false;
  await page.getByRole('button', { name: '刷新凭据列表', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: '凭据列表读取失败' })
    .waitFor({ state: 'hidden' });
  check(await create.isEnabled(), '列表恢复后操作未恢复');
  check(errors.length === 0, errors.join('; '));
  return {
    passed: 6,
    scenarios: [
      '签发失败与错误脱敏',
      '缺少凭据不冒充成功',
      '签发等待及重试成功',
      '取消及失败吊销',
      '吊销等待及重试成功',
      '列表失败及手动恢复',
    ],
    interceptedCreates: creates,
    interceptedDeletes: deletes,
  };
}
