/**
 * MVP smoke spec for the Job Theatre post-mortem view (/jobs/:taskId).
 *
 *   pnpm exec playwright test job-theatre.spec.ts
 *
 * Mocks the API at network level. Verifies:
 *   1. /jobs/{taskId} renders a DAG with task + step + qa nodes.
 *   2. Clicking a step node loads the prompt tab and exposes log content.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const PROJECT_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TASK_ID = '11111111-2222-3333-4444-555555555555';
const LOG_IMPL_ID = '20000000-0000-0000-0000-000000000001';
const LOG_REVIEW_ID = '20000000-0000-0000-0000-000000000002';
const QA_ID = '30000000-0000-0000-0000-000000000001';

const project = {
  id: PROJECT_ID,
  name: 'Web Demo',
  slug: 'web-demo',
  description: '',
  parent_id: null,
  default_playbook_id: null,
  repo_url: null,
  repo_path: null,
  default_branch: 'main',
  service_name: null,
  metadata: {},
  created_at: '2026-02-01T10:00:00Z',
  updated_at: '2026-03-15T08:00:00Z',
  git_mode: 'standalone',
  git_root: '/projects/web-demo',
  project_root: '/projects/web-demo',
  resolved_path: '/projects/web-demo',
  git_resolved_path: '/projects/web-demo',
};

const task = {
  id: TASK_ID,
  project_id: PROJECT_ID,
  number: 7,
  title: 'Add a healthz endpoint',
  kind: 'feature',
  state: 'done',
  urgent: false,
  context: { spec: 'Add a /healthz endpoint that returns 200.' },
  assigned_agent_id: 'agent-1',
  claimed_at: '2026-03-15T08:00:00Z',
  required_capabilities: [],
  assigned_role_id: null,
  delegated_by: null,
  delegated_at: null,
  playbook_id: null,
  playbook_step: 1,
  decision_id: null,
  created_by: '00000000-0000-0000-0000-000000000001',
  created_at: '2026-03-15T08:00:00Z',
  updated_at: '2026-03-15T08:30:00Z',
  completed_at: '2026-03-15T08:30:00Z',
  reverted_at: null,
  flagged: false,
  parent_id: null,
  input_tokens: 100,
  output_tokens: 200,
  cost_usd: 0.0042,
};

const logImplement = {
  id: LOG_IMPL_ID,
  task_id: TASK_ID,
  project_id: PROJECT_ID,
  agent_id: 'agent-1',
  step_name: 'implement',
  metadata: { provider: 'anthropic' },
  created_at: '2026-03-15T08:05:00Z',
};

const logReview = {
  id: LOG_REVIEW_ID,
  task_id: TASK_ID,
  project_id: PROJECT_ID,
  agent_id: 'agent-1',
  step_name: 'review',
  metadata: { provider: 'anthropic' },
  created_at: '2026-03-15T08:20:00Z',
};

const fullLogImplement = {
  ...logImplement,
  content: 'IMPL_PROMPT: Write the /healthz endpoint.\n<<<HANDOVER>>>done<<<END>>>',
};

const qaItem = {
  id: QA_ID,
  task_id: TASK_ID,
  project_id: PROJECT_ID,
  step_name: 'implement',
  kind: 'freeform',
  prompt: 'Which port should /healthz bind to?',
  options: null,
  responder: 'human',
  answer: '8080',
  answered_by: 'user-1',
  status: 'resolved',
  expires_at: null,
  created_at: '2026-03-15T08:07:00Z',
  answered_at: '2026-03-15T08:08:00Z',
  resolved_at: '2026-03-15T08:08:00Z',
  outcome: 'resolved_clean',
  metadata: {},
};

async function setupMocks(page: Page) {
  await page.route(/localhost:3100/, (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/v1\/?/, '');

    if (path === 'config' || url.pathname === '/v1/config') {
      return route.fulfill({ json: { auth_required: false, api_version: 'test' } });
    }
    if (path === '' || path === 'projects') {
      return route.fulfill({ json: [project] });
    }
    if (path === PROJECT_ID) {
      return route.fulfill({ json: project });
    }
    if (path === `tasks/${TASK_ID}`) {
      return route.fulfill({ json: task });
    }
    if (path === `${PROJECT_ID}/task-logs`) {
      return route.fulfill({
        json: { data: [logImplement, logReview], total: 2, limit: 500, offset: 0, has_more: false },
      });
    }
    if (path === `task-logs/${LOG_IMPL_ID}`) {
      return route.fulfill({ json: fullLogImplement });
    }
    if (path === `task-logs/${LOG_REVIEW_ID}`) {
      return route.fulfill({ json: { ...logReview, content: 'REVIEW_OK' } });
    }
    if (url.pathname === '/v1/v1/qa' || path === 'v1/qa') {
      return route.fulfill({ json: [qaItem] });
    }
    if (path === `${PROJECT_ID}/reports`) {
      return route.fulfill({ json: { data: [], total: 0, limit: 50, offset: 0, has_more: false } });
    }
    if (path === `audit/task/${TASK_ID}`) {
      return route.fulfill({
        json: [
          {
            id: '40000000-0000-0000-0000-000000000001',
            project_id: PROJECT_ID,
            entity_type: 'task',
            entity_id: TASK_ID,
            action: 'created',
            actor_agent_id: null,
            actor_user_id: 'user-1',
            actor_name: 'user-1',
            summary: 'Task created',
            before_state: null,
            after_state: null,
            metadata: {},
            created_at: '2026-03-15T08:00:00Z',
          },
        ],
      });
    }
    return route.fulfill({ status: 200, json: [] });
  });
}

test.describe('/jobs/:taskId (Job Theatre MVP)', () => {
  test('renders DAG and step click loads prompt', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/jobs/${TASK_ID}`);

    // DAG container is present
    await expect(page.locator('[data-testid="job-theatre"]')).toBeVisible();
    await expect(page.locator('[data-testid="job-theatre-graph"]')).toBeVisible();

    // Task node appears (auto-selected)
    await expect(page.locator(`[data-testid="job-node-task:${TASK_ID}"]`)).toBeVisible();

    // Step nodes appear
    await expect(page.locator('[data-testid="job-node-step:implement"]')).toBeVisible();
    await expect(page.locator('[data-testid="job-node-step:review"]')).toBeVisible();

    // Drawer is visible with the task title
    await expect(page.locator('[data-testid="job-theatre-drawer"]')).toBeVisible();

    // Click the implement step node
    await page.locator('[data-testid="job-node-step:implement"]').click();

    // Switch to the prompt tab
    await page.locator('[data-testid="drawer-tab-prompt"]').click();

    // Prompt content from the log content shows up
    await expect(page.locator('[data-testid="drawer-prompt"]')).toContainText('IMPL_PROMPT');
  });
});
