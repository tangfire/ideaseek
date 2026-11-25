async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const title = `长标题${'研究项目'.repeat(20)}LongUnbrokenProjectIdentifier`;
  const run = { external_run_id: 'responsive-run', phase_tag: 'PAPER_ANALYSIS', status: 'blocked', stage_known: true, started_at: null, finished_at: null };
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: `reviewer_${'long'.repeat(20)}`, owner_id: 'owner' };
    else if (url.pathname.endsWith('/views/index')) body = { ok: true, generated_at: '2026-11-25T00:00:00Z', projects: [
      { external_id: 'responsive-project', title, visibility: 'private', owned: true, archived: false, last_sync_at: null, latest_run: run }] };
    else if (url.pathname.endsWith('/views/commands')) body = { ok: true, commands: [], provisioning: [], audit: [] };
    else if (url.pathname.endsWith('/views/access')) body = { ok: true, grants: [], shares: [] };
    else if (url.pathname.endsWith('/views/project')) body = { ok: true, generated_at: '2026-11-25T00:00:00Z', projection_level: 'full', writable: true, visibility: 'private',
      project: { external_id: 'responsive-project', title, question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
      runs: [run], stages: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], unsynced: null,
      events: [{ seq: 1, ts: '2026-11-25T00:00:00Z', phase_tag: 'PAPER_ANALYSIS', type: 'task_created', summary: '测试事件', level: 'info', gap_before: 0, truncated: false }] };
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else throw new Error(`未声明的请求：${url.pathname}`);
    check(route.request().method() === 'GET', '布局检查不应发起写操作');
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  const fits = async (name) => {
    const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('input,select,textarea,button[role="tab"]')].filter((el) => el.getBoundingClientRect().width > 0)
        .filter((el) => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map((el) => el.outerHTML.slice(0, 100)) }));
    check(result.scroll <= result.width + 1 && result.overflow.length === 0, `${name} 溢出：${JSON.stringify(result)}`);
  };
  const labels = async () => {
    const missing = await page.locator('input:not([type="checkbox"]),select,textarea').evaluateAll((items) => items
      .filter((el) => el.getBoundingClientRect().width > 0 && !el.closest('label') && !document.querySelector(`label[for="${el.id}"]`))
      .map((el) => el.outerHTML.slice(0, 100)));
    check(missing.length === 0, `字段缺少可见标签：${missing.join(';')}`);
  };
  await page.goto('http://127.0.0.1:5174/#/console');
  await page.getByRole('heading', { name: '项目列表', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('填写后标签仍在');
  for (const width of [1440, 1024, 900, 768, 600, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await fits(`列表与创建 ${width}`); await labels();
    if (width <= 768) check(await page.getByRole('link', { name: '退出登录', exact: true }).isVisible(), `${width}px 账号入口被隐藏`);
  }
  check(await page.locator('td:not([data-label])').count() === 0, '移动列表缺少字段标签');
  await page.goto('http://127.0.0.1:5174/#/p/responsive-project');
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await fits(`项目概览 ${width}`);
    for (const tab of ['设置', '协作', '运行']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.waitForTimeout(100);
      await fits(`${tab} ${width}`); await labels();
    }
  }
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/responsive-settings.png', fullPage: true });
  const tabWidths = await page.getByRole('tab').evaluateAll((items) => items.map((el) => el.getBoundingClientRect().width));
  check(tabWidths.every((width) => width < 200), '窄屏页签仍被全局规则强制拉满');
  await page.goto('http://127.0.0.1:5174/#/login');
  await page.getByLabel('用户名', { exact: true }).waitFor();
  await labels(); await fits('登录');
  check(errors.length === 0, errors.join('; '));
  return { passed: 5, widths: [1440, 1024, 900, 768, 600, 390, 360, 320], scenarios: ['长标题列表/创建布局', '窄屏账号入口', '永久字段标签', '设置/协作/事件筛选', '页签与登录'], mutations: 0 };
}
