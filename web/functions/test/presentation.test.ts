import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../dev/fake-db.ts';
import { projectView, type Viewer } from '../views.ts';

function setup() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'presentation-owner' });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id, external_id: 'presentation-project', title: '界面回归',
    question: '研究问题', visibility: 'private', archived_at: null,
  });
  const run = fake.seed('cloud_run', {
    project_id: project.id, external_run_id: 'presentation-run', phase_tag: 'COMPLETED',
    status: 'succeeded', started_at: '2026-11-25T00:00:00Z',
  });
  const viewer: Viewer = {
    ownerId: String(owner.id), anonymousOwnerId: null, grantedProjectIds: [],
    limitedProjectIds: [], shareProjectId: null,
  };
  return { ...fake, project, run, viewer };
}

test('模拟实验经视图后不再变成真实完成，真实指标与规模保持原样', async () => {
  const fake = setup();
  fake.seed('cloud_research_node', {
    run_id: fake.run.id, node_id: 'demo', kind: 'experiment', status: 'completed',
    detail: { status: 'simulated', metrics: { accuracy: 0.99 } },
  });
  fake.seed('cloud_research_node', {
    run_id: fake.run.id, node_id: 'real', kind: 'experiment', status: 'completed',
    detail: { scale: 'quick', metrics: { accuracy: 0.81 } },
  });
  const response = await projectView(fake.db, fake.viewer, 'presentation-project', fake.BackendError);
  const view = await response.json();
  assert.equal(view.experiments[0].status, 'simulated');
  assert.equal(view.experiments[0].metrics, null);
  assert.equal(view.experiments[0].scale, null);
  assert.equal(view.experiments[1].status, 'completed');
  assert.equal(view.experiments[1].scale, 'quick');
  assert.equal(view.experiments[1].metrics.accuracy, 0.81);
});
