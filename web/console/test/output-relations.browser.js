async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const paperId = 'paper/中文#%';
  const ideaId = 'idea/中文#%';
  const experimentId = 'experiment/中文#%';
  let l2 = false;
  let outputPresent = true;
  let requests = 0;
  const paper = { external_paper_id: paperId, title: '明确来源论文', method_summary: '论文方法摘要', parse_status: 'succeeded' };
  const idea = { external_idea_id: ideaId, title: '引用论文的想法', mechanism_summary: '想法机制摘要', status: 'proposed', version: 1, hypothesis_disclosure: 'withheld',
    paper_sources: [{ reference_id: 'original-paper', paper_id: paperId, title: paper.title, status: 'linked' }] };
  const view = (id) => ({
    ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private', projection_level: l2 ? 'l2' : 'full', writable: !l2,
    project: { external_id: id, title: `来源 ${id}`, question: '研究问题', strategy: 'standard', autonomy: 'guided', last_sync_at: null },
    runs: [{ external_run_id: 'source-run', phase_tag: 'COMPLETED', status: 'succeeded', stage_known: true, started_at: null, finished_at: null }],
    stages: [], events: [], claims: [], protocols: [], unsynced: null,
    ...(!l2 && outputPresent ? {
      papers: [paper, { external_paper_id: 'paper-other', title: '无关联论文', parse_status: 'input_unverified' }],
      ideas: [idea,
        { ...idea, external_idea_id: 'idea-missing', title: '缺失来源想法', paper_sources: [
          { reference_id: 'missing-id', paper_id: null, title: null, status: 'missing' },
          { reference_id: 'ambiguous-id', paper_id: null, title: null, status: 'ambiguous' },
        ] },
        { ...idea, external_idea_id: 'idea-legacy', title: '未记录来源想法', paper_sources: null },
        { ...idea, external_idea_id: 'idea-unverified', title: '待核验来源想法', paper_sources: [
          { reference_id: 'paper-other', paper_id: 'paper-other', title: '无关联论文', status: 'unverified' },
        ] },
      ],
      experiments: [
        { external_spec_id: experimentId, idea_id: ideaId, status: 'simulated', scale: null, metrics: { accuracy: 0.9997 } },
        { external_spec_id: 'experiment-orphan', idea_id: 'not-in-this-run', status: 'completed', scale: null },
        { external_spec_id: 'experiment-no-idea', idea_id: null, status: 'completed', scale: null },
      ],
    } : {}),
  });
  await page.route('**/functions/v1/app/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/auth/me')) body = { ok: true, username: 'browser-review', owner_id: 'owner-review' };
    else if (url.pathname.endsWith('/views/project')) body = view(url.searchParams.get('external_id'));
    else if (url.pathname.endsWith('/live')) body = { frames: [] };
    else throw new Error(`查看来源不应发起其他请求：${url.pathname}`);
    requests++;
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/functions/v1/app/live**', () => {});
  await page.goto('http://127.0.0.1:5174/#/p/sources-one');
  await page.getByRole('heading', { name: '产出链', exact: true }).waitFor();
  const record = (kind, id) => page.locator(`[id="output-${kind}-${encodeURIComponent(id)}"]`);
  const paperCard = record('paper', paperId);
  const ideaCard = record('idea', ideaId);
  const experimentCard = record('experiment', experimentId);
  const focused = async (kind, id) => {
    await page.waitForFunction((expected) => document.activeElement?.id === expected, `output-${kind}-${encodeURIComponent(id)}`);
    check(await record(kind, id).evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight;
    }), '目标记录没有滚动到可见区域');
  };
  const urlBefore = page.url();
  const before = requests;
  await paperCard.getByRole('button', { name: idea.title, exact: true }).click();
  await focused('idea', ideaId);
  await ideaCard.getByRole('button', { name: paper.title, exact: true }).click();
  await focused('paper', paperId);
  await ideaCard.getByRole('button', { name: `${experimentId}（模拟演示）`, exact: true }).click();
  await focused('experiment', experimentId);
  await experimentCard.getByRole('button', { name: idea.title, exact: true }).click();
  await focused('idea', ideaId);
  check(page.url() === urlBefore, '查看来源改变了项目路由');
  check(requests === before, '查看来源意外发出了业务请求');
  check(await page.locator('.chain-arrow').count() === 0, '全局箭头仍暗示全部产出关联');
  check(await experimentCard.getByText('0.9997', { exact: false }).count() === 0, '模拟结果显示了指标');

  const missing = record('idea', 'idea-missing');
  check(await missing.getByRole('button').count() === 0, '缺失或歧义来源生成了可点击的假入口');
  await missing.getByText('missing-id · 当前运行未找到来源论文', { exact: true }).waitFor();
  await missing.getByText('ambiguous-id · 编号对应多个记录，无法确定来源', { exact: true }).waitFor();
  await record('idea', 'idea-legacy').getByText('未记录可核验的来源论文编号。', { exact: true }).waitFor();
  await record('experiment', 'experiment-orphan').getByText('not-in-this-run · 当前运行未找到关联想法。', { exact: true }).waitFor();
  await record('experiment', 'experiment-no-idea').getByText('未记录关联想法编号。', { exact: true }).waitFor();
  const unverified = record('idea', 'idea-unverified');
  await unverified.getByText('· 材料或分析状态待核验', { exact: true }).waitFor();
  await unverified.getByRole('button', { name: '无关联论文', exact: true }).click();
  await focused('paper', 'paper-other');

  const measurements = [];
  for (const width of [1440, 1024, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const fits = await page.locator('.output-record').evaluateAll((elements) => elements.every((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
    }));
    check(fits, `${width}px 来源记录超出页面或内容区域`);
    await experimentCard.getByRole('button', { name: idea.title, exact: true }).focus();
    await page.keyboard.press('Enter');
    await focused('idea', ideaId);
    measurements.push(width);
  }
  await ideaCard.screenshot({ path: 'output/playwright/output-source-narrow.png', timeout: 6000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await ideaCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/output-source-wide.png', timeout: 6000 });

  outputPresent = false;
  await page.evaluate(() => { location.hash = '#/p/sources-two'; });
  await page.getByRole('heading', { name: '来源 sources-two', exact: true }).waitFor();
  check(await page.locator('.output-record').count() === 0, '切换项目后旧来源记录仍可查看');
  l2 = true;
  outputPresent = true;
  await page.reload();
  await page.getByText('当前为公开摘要。', { exact: false }).waitFor();
  check(await page.locator('.output-relations').count() === 0, '降级视图显示了来源关系');
  return { passed: 6, widths: measurements, scenarios: ['四向跳转与路由保持', '缺失与歧义保护', '未核验材料标注', '窄屏与键盘', '跨项目隔离', '降级权限'], stepRequests: 0 };
}
