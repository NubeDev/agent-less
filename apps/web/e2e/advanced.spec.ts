/**
 * UI-4 / UI-5 smoke spec for the `/advanced` flow.
 *
 *   pnpm exec playwright test advanced.spec.ts
 *
 * Mocks the API at network level. Verifies:
 *   1. `/advanced/new` loads, shows resolved preview, submits a task.
 *   2. Live preview reflects per-task overrides + safety upgrade fires
 *      when accept=confidence is picked on a playbook with a Merge step.
 *   3. `/advanced/:id` renders the step timeline, QA history panel,
 *      cost breakdown, and resolved playbook YAML.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const PROJECT_ID = 'b1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TASK_ID = '22222222-3333-4444-5555-666666666666';
const QA_ID = '88888888-aaaa-bbbb-cccc-dddddddddddd';
const PLAYBOOK_ID = 'pb-adv-001';

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

const playbook = {
  id: PLAYBOOK_ID,
  tenant_id: null,
  title: 'standard',
  trigger_description: '',
  steps: [
    { name: 'Implement', description: '', on_complete: 'review', step: 1, model: 'gpt-5', budget: 5 },
    { name: 'Review', description: '', on_complete: 'merge', step: 2 },
    { name: 'Merge', description: '', on_complete: 'done', step: 3, git_action: 'merge' as const },
  ],
  tags: [],
  initial_state: 'ready' as const,
  metadata: {},
  created_at: '',
  created_by: '',
  updated_at: '',
};

function mkTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    project_id: PROJECT_ID,
    number: 7,
    title: 'Wire up advanced job',
    kind: 'feature',
    state: 'working',
    urgent: false,
    context: {
      session_mode: 'per_step',
      preserve_worktree: true,
      qa_override: { responder: 'ai', accept: 'second_pass', min_confidence: 0.9 },
    },
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
    cost_usd: 0.0123,
    ...overrides,
  };
}

const handoverUpdate = {
  id: 'upd-1',
  task_id: TASK_ID,
  agent_id: 'ag-1',
  user_id: null,
  kind: 'handover',
  content: 'Decided to use postgres. Schema lives in 050_advanced.sql.',
  metadata: { step_name: 'Implement', cost_usd: 0.005 },
  created_at: '2026-03-15T08:05:00Z',
};

const resolvedQa = {
  id: QA_ID,
  task_id: TASK_ID,
  project_id: PROJECT_ID,
  step_name: 'Implement',
  kind: 'freeform',
  prompt: 'Which test framework should I use?',
  options: null,
  responder: 'ai',
  answer: 'vitest',
  answered_by: 'agent:gpt-5',
  status: 'resolved',
  expires_at: null,
  created_at: '2026-03-15T08:06:00Z',
  answered_at: '2026-03-15T08:06:30Z',
  resolved_at: '2026-03-15T08:06:30Z',
  metadata: { confidence: 0.92, accept_mode: 'confidence', cost_usd: 0.001 },
  outcome: 'resolved_clean',
};

async function setupMocks(page: Page) {
  await page.route(/localhost:3100/, (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/v1\/?/, '');
    const method = route.request().method();
    const search = url.searchParams;

    if (path === 'config' || url.pathname === '/v1/config') {
      return route.fulfill({ json: { auth_required: false, api_version: 'test' } });
    }
    if (path === '' || path === 'projects') {
      return route.fulfill({ json: [project] });
    }
    if (path === PROJECT_ID) {
      return route.fulfill({ json: project });
    }
    if (path === `projects/${PROJECT_ID}/playbooks`) {
      return route.fulfill({ json: [playbook] });
    }
    if (path === `${PROJECT_ID}/knowledge`) {
      return route.fulfill({ json: { data: [] } });
    }
    if (path === `${PROJECT_ID}/verifications`) {
      return route.fulfill({ json: { data: [], total: 0, limit: 50, offset: 0, has_more: false } });
    }
    if (path === `${PROJECT_ID}/reports`) {
      return route.fulfill({ json: { data: [], total: 0, limit: 50, offset: 0, has_more: false } });
    }
    if (path === 'agents') {
      return route.fulfill({ json: [] });
    }
    if (method === 'POST' && path === `${PROJECT_ID}/tasks`) {
      return route.fulfill({ json: mkTask() });
    }
    if (path === `tasks/${TASK_ID}`) {
      return route.fulfill({ json: mkTask() });
    }
    if (path === `tasks/${TASK_ID}/updates`) {
      return route.fulfill({ json: [handoverUpdate] });
    }
    if (path === `tasks/${TASK_ID}/changed-files`) {
      return route.fulfill({ json: [] });
    }
    if (path === 'v1/qa' || url.pathname === '/v1/qa') {
      const tid = search.get('task_id');
      if (tid === TASK_ID) {
        return route.fulfill({ json: [resolvedQa] });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ status: 200, json: {} });
  });
}

test.describe('/advanced/new', () => {
  test('renders form, preview, and submits', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/advanced/new');
    await expect(page.getByRole('heading', { name: 'New job (advanced)' })).toBeVisible();
    await expect(page.getByText('Resolved playbook preview')).toBeVisible();

    // Fill spec, submit, redirect to detail.
    await page.locator('textarea[name="spec"]').fill('Wire up advanced job');
    await page.locator('[data-testid="advanced-submit"]').click();
    await page.waitForURL(`**/advanced/${TASK_ID}`);
  });

  test('safety block fires when accept=confidence chosen on Merge playbook', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/advanced/new');
    // Open QA panel.
    await page.getByText('4. QA policy (overrides playbook per step)').click();
    await page.locator('select[name="qaAccept"]').selectOption('confidence');
    await page.locator('textarea[name="spec"]').fill('try to merge with confidence');
    // Submit is blocked because the playbook has a Merge step.
    await expect(page.locator('[data-testid="advanced-submit"]')).toBeDisabled();
    await expect(page.getByText(/accept=confidence is not allowed/)).toBeVisible();
  });
});

test.describe('/advanced/:id', () => {
  test('renders timeline, QA panel, cost, playbook', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/advanced/${TASK_ID}`);
    await expect(page.getByRole('heading', { name: 'Wire up advanced job' })).toBeVisible();
    await expect(page.locator('[data-testid="adv-timeline"]')).toBeVisible();
    await expect(page.locator('[data-testid="qa-history-panel"]')).toBeVisible();
    await expect(page.getByText('Which test framework should I use?')).toBeVisible();
    await expect(page.locator('[data-testid="adv-cost"]')).toBeVisible();
    await expect(page.getByText('Playbook used (resolved)')).toBeVisible();
  });
});
