async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  let l2 = false;
  let revision = 1;
  let requests = 0;
  const long = (label) => `${label}原文\n${'研究内容 with words 😀 '.repeat(35)}\n${label}末尾-${revision}`;
  const paper = () => ({ external_paper_id: 'paper-long', title: '长内容论文', question: long('论文问题'), method_summary: long('论文方法'), parse_status: 'succeeded' });
  const idea = () => ({ external_idea_id: 'idea-long', title: '长内容想法', mechanism_summary: long('机制'), hypothesis: 'private-hypothesis-sentinel',
    hypothesis_disclosure: 'withheld', status: 'proposed', version: revision,
    paper_sources: [{ reference_id: 'paper-long', paper_id: 'paper-long', title: '长内容论文', status: 'linked' }] });
  const view = (id) => ({ ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private', projection_level: l2 ? 'l2' : 'full', writable: !l2,
    project: { external_id: id, title: `长内容 ${id}`, question: long('研究问题'), strategy: 'standard', autonomy: 'guided', last_sync_at: null },
    runs: [{ external_run_id: 'text-run', phase_tag: 'COMPLETED', status: 'succeeded', stage_known: true, started_at: null, finished_at: null }],
    stages: [], events: [], unsynced: null,
    ...(!l2 ? { papers: [paper(), { external_paper_id: 'paper-short', title: '短内容论文', question: '短研究问题', method_summary: '短方法摘要', parse_status: 'succeeded' }],
      ideas: [idea()], experiments: [], claims: [{ external_claim_id: 'claim-long', text: long('结论'), support_level: 'uncertain' }],
      protocols: [{ external_protocol_id: 'protocol-long', provenance: long('协议'), locked_at: null }] } : {}),
  });
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    else if (url.pathname.endsWith('/views/project')) body = view(url.searchParams.get('external_id'));
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else if (url.pathname.endsWith('/views/resources')) body = { ok: true, external_run_id: 'text-run', tasks_truncated: false, artifacts_truncated: false, artifacts: [],
      tasks: [{ external_task_id: 'task-long', kind: 'analyze_paper', stage: 'PAPER_ANALYSIS', status: 'succeeded', attempt: 1, max_attempts: 3,
        started_at: null, ended_at: null, simulated: false,
        input: [{ label: '论文正文', value: `${'<script>纯文本</script>'.repeat(90)}已返回正文末尾`, truncated: true }],
        output: [{ label: '说明', value: [{ 备注: '一\n二\n三\n四-多行末尾' }], truncated: false }] }] };
    else throw new Error(`展开文本不应调用其他接口：${url.pathname}`);
    requests++;
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/p/text-one');
  await page.getByRole('heading', { name: '产出链', exact: true }).waitFor();
  const paperCard = page.locator('#output-paper-paper-long');
  const ideaCard = page.locator('#output-idea-idea-long');
  const question = page.locator('.expandable-text').filter({ has: page.locator('summary', { hasText: '展开研究问题' }) }).first();
  const method = paperCard.locator('.expandable-text').filter({ has: page.locator('summary', { hasText: '展开方法摘要' }) });
  const complete = method.locator('.text-body');
  check(!(await complete.isVisible()), '方法长文默认铺满卡片');
  check(await page.locator('#output-paper-paper-short .expandable-text').count() === 0, '短内容多了不必要的折叠');
  await page.getByText('短方法摘要', { exact: true }).waitFor();
  const beforeRequests = requests;
  const beforeUrl = page.url();
  await method.locator('summary').focus();
  await page.keyboard.press('Enter');
  check(await complete.innerText() === long('论文方法'), '展开后没有保留原始换行和末尾');
  check(await complete.isVisible(), '键盘不能展开方法摘要');
  check(!(await method.locator('.text-preview').isVisible()), '展开后仍重复展示预览');
  await method.getByText('收起方法摘要', { exact: true }).waitFor();
  await page.keyboard.press('Enter');
  check(!(await complete.isVisible()), '键盘不能收起摘要');
  check(await method.locator('.text-preview').isVisible(), '收起后预览消失');
  const mechanism = ideaCard.locator('.expandable-text');
  await mechanism.locator('summary').click();
  check(await mechanism.locator('.text-body').innerText() === long('机制'), '机制长文丢失');
  await mechanism.locator('summary').click();
  check(!((await page.locator('body').textContent()).includes('private-hypothesis-sentinel')), '未授权假设通过展开泄漏');
  await paperCard.getByRole('button', { name: '长内容想法', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === 'output-idea-idea-long');
  check(page.url() === beforeUrl && requests === beforeRequests, '文本展开或来源跳转产生了业务请求或路由变化');
  const widths = [];
  for (const width of [1440, 1024, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const collapsedHeight = await paperCard.evaluate((el) => el.getBoundingClientRect().height);
    check(await method.locator('.text-preview').evaluate((el) => {
      const style = getComputedStyle(el);
      const lineHeight = Number.parseFloat(style.lineHeight);
      return !Number.isFinite(lineHeight) || el.getBoundingClientRect().height <= lineHeight * 3 + 2;
    }), `${width}px 预览超过三行`);
    await method.locator('summary').click();
    check(await paperCard.evaluate((el) => el.getBoundingClientRect().height) > collapsedHeight, `${width}px 展开后仍截断长文`);
    check(await paperCard.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
    }), `${width}px 长文本溢出`);
    await method.locator('summary').click();
    widths.push(width);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await paperCard.screenshot({ path: 'output/playwright/text-preview-narrow.png', timeout: 6000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await paperCard.screenshot({ path: 'output/playwright/text-preview-wide.png', timeout: 6000 });
  await question.locator('summary').click();
  revision = 2;
  await page.evaluate(() => { location.hash = '#/p/text-two'; });
  await page.getByRole('heading', { name: '长内容 text-two', exact: true }).waitFor();
  await page.getByText('展开研究问题', { exact: true }).waitFor();
  check(!(await question.locator('details').evaluate((el) => el.open)), '新内容继承了旧展开状态');
  await page.getByRole('tab', { name: '材料与成果', exact: true }).click();
  await page.getByRole('button', { name: '查看输入与产出', exact: true }).click();
  const detail = page.getByRole('region', { name: '材料与产出详情', exact: true });
  const taskText = detail.locator('.expandable-text').first();
  check(!(await taskText.locator('.text-body').isVisible()), '材料长字段默认展开');
  await taskText.locator('summary').click();
  check((await taskText.locator('.text-body').innerText()).endsWith('已返回正文末尾'), '材料展开丢失末尾');
  check(await detail.locator('script').count() === 0, '材料被当作脚本执行');
  await detail.getByText('内容较长，仅展示部分记录。', { exact: true }).waitFor();
  check(!(await detail.innerText()).includes('展开全文'), '部分载荷被标为全文');
  const multiline = detail.locator('.expandable-text').last();
  await multiline.locator('summary').click();
  check(await multiline.locator('.text-body').innerText() === '一\n二\n三\n四-多行末尾', '多行短文本没有保留');
  await page.locator('.resources').screenshot({ path: 'output/playwright/text-expanded-record.png', timeout: 6000 });
  l2 = true;
  await page.reload();
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  check(await page.getByText('展开机制摘要', { exact: true }).count() === 0, 'L2 显示了想法内容');
  check(browserErrors.length === 0, `浏览器错误：${browserErrors.join('; ')}`);
  return { passed: 7, widths, scenarios: ['长短文本分层', '键盘展开收起与原文保留', '假设权限保护', '三行预览与宽窄屏', '来源跳转保持', '新内容状态隔离', '材料截断及转义'], mutations: 0 };
}
