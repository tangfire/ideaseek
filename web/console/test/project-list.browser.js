async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const writes = [];
  let failArchive = false;
  let creatingReply = 'created';
  let releaseCreate;
  const base = (id, title, status, owned = true, archived = false) => ({ external_id: id, title, owned, archived, visibility: 'private', last_sync_at: null,
    latest_run: status === null ? null : { external_run_id: `run-${id}`, phase_tag: 'PAPER_ANALYSIS', stage_known: true, status: status === 'hidden' ? undefined : status, started_at: null, finished_at: null } });
  const projects = [base('active-project', '运行项目', 'running'), base('new-project', '未开始项目', 'created'), base('done-project', '完成项目', 'succeeded'),
    base('blocked-project', '等待项目', 'blocked'), base('recoverable-project', '可恢复项目', 'FAILED_RECOVERABLE'), base('empty-project', '无运行项目', null),
    base('public-project', '受邀项目', 'hidden', false), base('archived-project', '旧项目', 'succeeded', true, true)];
  await page.route('**/functions/v1/app/**', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: 'reviewer', owner_id: 'owner' };
    else if (url.pathname.endsWith('/views/index')) body = { ok: true, generated_at: '2026-11-25T00:00:00Z', projects: projects.filter((p) => url.searchParams.has('include_archived') || !p.archived) };
    else if (url.pathname.endsWith('/views/commands')) body = { ok: true, commands: [], provisioning: [], audit: [] };
    else if (url.pathname.endsWith('/views/project')) body = { ok: true, generated_at: '2026-11-25T00:00:00Z', projection_level: 'full', writable: true, visibility: 'private',
      project: { external_id: 'active-project', title: '运行项目', question: '问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
      runs: [], stages: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], events: [], unsynced: null };
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else if (request.method() === 'POST' && url.pathname.endsWith('/projects')) {
      writes.push({ method: 'POST', kind: 'create', body: request.postDataJSON() });
      await new Promise((resolve) => { releaseCreate = resolve; });
      const sent = request.postDataJSON();
      if (creatingReply === 'created') projects.push(base(`created-${projects.length}`, sent.name, 'created'));
      body = { ok: true, cloud_executed: creatingReply === 'created' };
    } else if (url.pathname.endsWith('/restore')) {
      const project = projects.find((p) => url.pathname.endsWith(`/projects/${p.external_id}/restore`));
      check(project && request.method() === 'POST', '恢复目标错误');
      writes.push({ kind: 'restore', id: project.external_id }); project.archived = false; body = { ok: true };
    } else {
      const project = projects.find((p) => url.pathname.endsWith(`/projects/${p.external_id}`));
      check(project && project.owned, `未声明的请求：${url.pathname}`);
      writes.push({ kind: request.method(), id: project.external_id });
      if (request.method() === 'DELETE') {
        check(url.searchParams.get('confirm') === project.title, '归档未发送准确标题');
        if (failArchive) { await route.fulfill({ status: 503, json: { ok: false } }); return; }
        project.archived = true;
      } else if (request.method() === 'PATCH') project.title = request.postDataJSON().title;
      else throw new Error('不允许的测试请求');
      body = { ok: true };
    }
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/console');
  await page.getByRole('link', { name: '运行项目', exact: true }).waitFor();
  const filter = page.getByLabel('状态筛选', { exact: true });
  for (const [value, title] of [['运行中', '运行项目'], ['尚未开始', '未开始项目'], ['已结束', '完成项目'], ['需处理', '可恢复项目'], ['无运行', '无运行项目'], ['状态未公开', '受邀项目']]) {
    await filter.selectOption({ label: value });
    check(await page.getByRole('link', { name: title, exact: true }).isVisible(), `状态筛选遗漏 ${title}`);
  }
  await filter.selectOption({ label: '全部' });
  await page.getByRole('link', { name: '运行项目', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/#/p/active-project');
  await page.locator('.main-content').getByRole('link', { name: '← 项目列表', exact: true }).click();
  await page.getByRole('link', { name: '运行项目', exact: true }).waitFor();
  const target = () => page.locator('tr').filter({ has: page.getByRole('link', { name: '运行项目', exact: true }) });
  check(await target().getByRole('button', { name: '归档', exact: true }).isVisible() === false, '危险操作默认暴露在主列表');
  await target().locator('summary').click();
  await target().getByRole('button', { name: '归档', exact: true }).click();
  await page.getByLabel('输入项目标题确认归档', { exact: true }).fill('错误标题');
  check(await page.getByRole('button', { name: '确认归档', exact: true }).isDisabled(), '错误标题允许归档');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  check(writes.length === 0 && page.url().endsWith('#/console'), '取消归档发送了请求或改变路由');
  await target().locator('summary').click();
  await target().getByRole('button', { name: '归档', exact: true }).click();
  await page.getByLabel('输入项目标题确认归档', { exact: true }).fill('运行项目');
  failArchive = true;
  await page.getByRole('button', { name: '确认归档', exact: true }).click();
  await page.getByRole('alert').getByText('云端服务暂时不可用', { exact: false }).waitFor();
  check(await page.getByLabel('输入项目标题确认归档').inputValue() === '运行项目', '失败后丢失确认输入');
  failArchive = false;
  await page.getByRole('button', { name: '确认归档', exact: true }).click();
  await page.getByRole('link', { name: '运行项目', exact: true }).waitFor({ state: 'hidden' });
  await page.getByLabel('项目范围', { exact: true }).selectOption('archived');
  await page.getByText('旧项目', { exact: true }).waitFor();
  check(await page.getByRole('link', { name: '运行项目', exact: true }).count() === 0, '归档项目仍提供不可打开的链接');
  const archived = page.locator('tr').filter({ has: page.getByText('运行项目', { exact: true }) });
  await archived.getByRole('button', { name: '恢复', exact: true }).click();
  await page.getByText('运行项目', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByLabel('项目范围', { exact: true }).selectOption('active');
  await page.getByRole('link', { name: '运行项目', exact: true }).waitFor();
  await page.getByRole('button', { name: '卡片视图', exact: true }).click();
  const card = page.locator('.panel').filter({ has: page.getByRole('heading', { name: '运行项目', exact: true }) });
  await card.locator('summary').click();
  await card.getByRole('button', { name: '改名', exact: true }).click();
  await page.getByLabel('新标题', { exact: true }).fill('更名项目');
  await page.getByLabel('新标题', { exact: true }).press('Enter');
  await page.getByRole('link', { name: '更名项目', exact: true }).waitFor();
  const unowned = page.locator('.panel').filter({ has: page.getByRole('heading', { name: '受邀项目', exact: true }) });
  check(await unowned.locator('summary').count() === 0, '受邀项目显示管理菜单');
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('新创建的项目');
  await page.getByLabel('项目名称', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '创建中…', exact: true }).waitFor();
  check(await page.getByRole('button', { name: '创建中…', exact: true }).isDisabled(), '创建等待期间可以重复提交');
  releaseCreate();
  await page.getByRole('link', { name: '新创建的项目', exact: true }).waitFor();
  check(await page.getByRole('region', { name: '创建项目', exact: true }).count() === 0, '创建成功后表单未收起');
  check(await page.getByRole('button', { name: '新建项目', exact: true }).evaluate((el) => document.activeElement === el), '创建完成后焦点丢失');
  creatingReply = 'pending';
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('尚在创建的项目');
  await page.getByRole('button', { name: '立即创建', exact: true }).click();
  await page.getByRole('button', { name: '创建中…', exact: true }).waitFor();
  releaseCreate();
  await page.getByText('项目创建中…', { exact: true }).waitFor();
  check(await page.getByRole('region', { name: '创建项目', exact: true }).isVisible(), '待处理创建请求被当成创建成功');
  await page.getByRole('button', { name: '收起创建', exact: true }).click();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px 卡片视图溢出`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'output/playwright/project-list-wide.png', fullPage: true });
  check(errors.length === 0, errors.join('; '));
  return { passed: 8, scenarios: ['状态筛选大小写/未开始/可恢复/未公开', '键盘打开项目', '危险操作折叠与取消', '精确确认/失败恢复/归档', '归档区恢复', '卡片更名/权限', '创建等待/成功/待处理', '卡片宽窄屏'], interceptedWrites: writes.length };
}
