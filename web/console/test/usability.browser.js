async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let status = 'running';
  let phase = 'PROTOCOL_REVIEW';
  let readOnly = false;
  let limited = false;
  const projectView = (id) => ({ ok: true, generated_at: '2026-11-25T00:00:00Z', projection_level: limited ? 'l2' : 'full', writable: !readOnly, visibility: 'listed',
    project: { external_id: id, title: '界面评审项目', question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
    runs: [{ external_run_id: 'review-run', phase_tag: phase, status: limited ? undefined : status, stage_known: true, started_at: null, finished_at: null }],
    stages: [], papers: [], ideas: [], experiments: [], claims: [], protocols: [], events: [], unsynced: null });
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: 'reviewer', owner_id: 'owner-review' };
    else if (url.pathname.endsWith('/views/project')) body = projectView(url.searchParams.get('external_id'));
    else if (url.pathname.endsWith('/views/index')) body = { ok: true, generated_at: '2026-11-25T00:00:00Z', projects: [] };
    else if (url.pathname.endsWith('/views/commands')) body = { ok: true, commands: [], provisioning: [], audit: [] };
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else throw new Error(`未声明的请求：${url.pathname}`);
    check(route.request().method() === 'GET', '不应写入真实服务');
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/p/review-one');
  await page.getByRole('heading', { name: '界面评审项目', exact: true }).waitFor();
  const stage = page.locator('.status-chip[title="PROTOCOL_REVIEW"]');
  check(await stage.getAttribute('data-state') === 'idle', '阶段被错误涂成运行或阻塞状态');
  check(await page.getByText('公开', { exact: true }).getAttribute('data-state') === 'idle', '可见性被错误涂成成功状态');
  const runningColor = await page.locator('.status-chip[title="running"]').evaluate((el) => getComputedStyle(el).color);
  status = 'succeeded'; phase = 'COMPLETED';
  await page.reload();
  const completed = page.locator('.status-chip[title="succeeded"]');
  await completed.waitFor();
  check(await page.locator('.status-chip[title="COMPLETED"]').count() === 0, '完成阶段和运行重复显示');
  check(await completed.evaluate((el) => getComputedStyle(el).color) !== runningColor, '运行中与成功仍同色');
  status = 'QUOTA_EXHAUSTED'; phase = 'PAPER_ANALYSIS';
  await page.reload();
  await page.locator('.status-chip[title="QUOTA_EXHAUSTED"]').waitFor();
  check(await page.locator('.status-chip[data-state="quota"]').count() === 1, '额度耗尽出现重复徽标');
  check(await page.getByText('阶段标记：', { exact: false }).count() === 1, '阶段缺少非颜色说明');
  const selected = page.locator('.sidebar a[aria-current="page"]');
  check(await selected.count() === 1 && await selected.textContent() === '当前项目', '普通项目误选演示项目');
  await page.goto('http://127.0.0.1:5174/#/p/review-two');
  await page.getByRole('heading', { name: '界面评审项目', exact: true }).waitFor();
  check(await selected.getAttribute('href') === '#/p/review-two', '当前项目入口未跟随项目切换');
  await page.getByRole('link', { name: '演示项目', exact: true }).click();
  await page.waitForURL('**/#/p/proj-8f6c57e4-56e');
  check(await selected.textContent() === '演示项目', '演示项目未正确选中');
  await page.locator('.sidebar').getByRole('link', { name: '项目列表', exact: true }).click();
  await page.getByRole('heading', { name: '项目列表', exact: true }).waitFor();
  check(await selected.textContent() === '项目列表', '返回列表后导航仍选择项目');
  await page.goto('http://127.0.0.1:5174/#/p/review-one');
  await page.getByRole('heading', { name: '界面评审项目', exact: true }).waitFor();
  const bodyText = await page.locator('body').innerText();
  for (const jargon of ['投影', 'L1', 'L2', 'Owner', 'Function']) check(!bodyText.includes(jargon), `主界面仍显示实现术语：${jargon}`);
  readOnly = true;
  await page.reload();
  await page.getByText('当前为只读访问，运行操作由项目所有者执行。', { exact: true }).waitFor();
  check(await page.getByRole('button', { name: '继续运行', exact: true }).count() === 0, '只读读者仍显示运行操作');
  limited = true;
  await page.reload();
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  check(await page.getByRole('tab', { name: '材料与成果', exact: true }).count() === 0, '公开摘要显示私有材料入口');
  check(errors.length === 0, errors.join('; '));
  return { passed: 5, scenarios: ['运行状态与阶段分离', '完成及额度状态去重', '普通属性中性与阶段符号说明', '普通项目/演示/列表导航', '用户文案与只读/公开摘要'], mutations: 0 };
}
