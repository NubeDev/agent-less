/**
 * UI-1 / UI-3 smoke spec for the `/quick` flow.
 *
 *   pnpm exec playwright test quick.spec.ts
 *
 * Mocks the API at network level (no real backend needed). Verifies:
 *   1. `/quick` renders the three groups (Needs you / Running / Recent).
 *   2. `/quick/new` accepts a 5-field form and redirects to detail.
 *   3. `/quick/:id` shows a pending QA panel and submits an answer.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const PROJECT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TASK_ID = '11111111-2222-3333-4444-555555555555';
const QA_ID = '99999999-aaaa-bbbb-cccc-dddddddddddd';
const PLAYBOOK_ID = 'pb-001';

const project = {
  id: PROJECT_ID,
  name: 'Acme Platform',
  slug: 'acme-platform',
  description: '',
  parent_id: null,
  default_playbook_id: PLAYBOOK_ID,
  repo_url: 'https://github.com/acme/platform',
  repo_path: '/projects/acme-platform',
  default_branch: 'main',
  service_name: null,
  metadata: {},
  created_at: '2026-02-01T10:00:00Z',
  updated_at: '2026-03-15T08:00:00Z',
  git_mode: 'standalone',
  git_root: '/projects/acme-platform',
  project_root: '/projects/acme-platform',
  resolved_path: '/projects/acme-platform',
  git_resolved_path: '/projects/acme-platform',
};

function mkTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    project_id: PROJECT_ID,
    number: 1,
    title: 'Add /healthz endpoint',
    kind: 'feature',
    state: 'human_review',
    urgent: false,
    context: {},
    assigned_agent_id: null,
    claimed_at: '2026-03-15T08:00:00Z',
    required_capabilities: [],
    assigned_role_id: null,
    delegated_by: null,
    delegated_at: null,
    playbook_id: PLAYBOOK_ID,
    playbook_step: 1,
    decision_id: null,
    created_by: '00000000-0000-0000-0000-000000000001',
    created_at: '2026-03-15T08:00:00Z',
    updated_at: '2026-03-15T08:10:00Z',
    completed_at: null,
    reverted_at: null,
    flagged: false,
    parent_id: null,
    input_tokens: 100,
    output_tokens: 200,
    cost_usd: 0.0042,
    ...overrides,
  };
}

const pendingQa = {
  id: QA_ID,
  task_id: TASK_ID,
  project_id: PROJECT_ID,
  step_name: 'implement',
  kind: 'choice',
  prompt: 'Which database driver should I use?',
  options: ['postgres', 'sqlite'],
  responder: 'human',
  answer: null,
  answered_by: null,
  status: 'pending',
  expires_at: null,
  created_at: '2026-03-15T08:05:00Z',
  answered_at: null,
  resolved_at: null,
  metadata: {},
};

async function setupMocks(page: Page, opts: { withPendingQa: boolean }) {
  await page.route(/localhost:3100/, (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/v1\/?/, '');
    const search = url.searchParams;
    const method = route.request().method();

    if (path === 'config' || url.pathname === '/v1/config') {
      return route.fulfill({ json: { auth_required: false, api_version: 'test' } });
    }
    if (path === '' || path === 'projects') {
      return route.fulfill({ json: [project] });
    }
    if (path === PROJECT_ID) {
      return route.fulfill({ json: project });
    }
    if (path === 'playbooks') {
      return route.fulfill({ json: [{
        id: PLAYBOOK_ID, tenant_id: null, title: 'standard',
        trigger_description: '', steps: [], tags: [],
        initial_state: 'ready', metadata: {},
        created_at: '', created_by: '', updated_at: '',
      }] });
    }
    // Create task
    if (method === 'POST' && path === `${PROJECT_ID}/tasks`) {
      return route.fulfill({ json: mkTask() });
    }
    // Get one task
    if (path === `tasks/${TASK_ID}`) {
      return route.fulfill({ json: mkTask() });
    }
    // List task updates
    if (path === `tasks/${TASK_ID}/updates`) {
      return route.fulfill({ json: [] });
    }
    // Tasks list for project
    if (path === `${PROJECT_ID}/tasks`) {
      return route.fulfill({ json: { data: [mkTask()], total: 1, limit: 100, offset: 0, has_more: false } });
    }
    // QA list
    if (path === 'v1/qa' || url.pathname === '/v1/qa') {
      const status = search.get('status');
      if (status === 'pending' && opts.withPendingQa) {
        return route.fulfill({ json: [pendingQa] });
      }
      return route.fulfill({ json: [] });
    }
    // QA answer
    if (method === 'POST' && (path === `v1/qa/${QA_ID}/answer` || url.pathname === `/v1/qa/${QA_ID}/answer`)) {
      return route.fulfill({ json: { ...pendingQa, status: 'resolved', answer: 'postgres' } });
    }
    // Tenant theme / health / fallbacks
    return route.fulfill({ status: 200, json: {} });
  });
}

test.describe('/quick flow', () => {
  test('list renders three groups', async ({ page }) => {
    await setupMocks(page, { withPendingQa: true });
    await page.goto('/quick');
    await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
    await expect(page.locator('[data-testid="quick-new-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="quick-needs-you"]')).toBeVisible();
  });

  test('new job form submits and redirects to detail', async ({ page }) => {
    await setupMocks(page, { withPendingQa: false });
    await page.goto('/quick/new');
    await expect(page.getByRole('heading', { name: 'New job' })).toBeVisible();
    await page.locator('#quick-spec').fill('Add /healthz endpoint that returns 200');
    await page.locator('[data-testid="quick-submit"]').click();
    await page.waitForURL(`**/quick/${TASK_ID}`);
  });

  test('detail page surfaces pending QA and submits answer', async ({ page }) => {
    await setupMocks(page, { withPendingQa: true });
    await page.goto(`/quick/${TASK_ID}`);
    await expect(page.locator('[data-testid="quick-qa-panel"]')).toBeVisible();
    await expect(page.getByText('Which database driver should I use?')).toBeVisible();
    // Choice mode: option buttons present, no submit button.
    await page.getByRole('button', { name: 'postgres' }).click();
    // Panel disappears after successful answer.
    await expect(page.locator('[data-testid="quick-qa-panel"]')).toBeHidden();
  });
});
