/**
 * UI-2 spec: DefaultRouteGuard redirect + pref-stickiness.
 *
 *   pnpm exec playwright test default-route.spec.ts
 *
 * Closes the two "[ ] covered manually" bullets under UI-2 Tests in
 * UI-UPDATES.md:
 *   - First-login redirect (no localStorage key set → /quick).
 *   - Pref-stickiness across refreshes (key='advanced' → /dashboard
 *     on every visit to `/`, no toggle UI required).
 *
 * Uses the same auth_required=false bypass pattern as quick.spec.ts:
 * /v1/config returns auth_required=false, AuthService.markAuthDisabled
 * fires, and DefaultRouteGuard sees an authenticated user without
 * needing OIDC. No real backend required — every API call is stubbed.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const MODE_KEY = 'diraigent.uiMode';

/**
 * Mock the bare minimum so /quick and /dashboard both render past the
 * guard without crashing on data fetches.
 */
async function setupMocks(page: Page): Promise<void> {
  await page.route(/localhost:3100/, (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/v1\/?/, '');

    if (path === 'config' || url.pathname === '/v1/config') {
      return route.fulfill({ json: { auth_required: false, api_version: 'test' } });
    }
    if (path === '' || path === 'projects') {
      return route.fulfill({ json: [] });
    }
    // QA list (both pages may probe it)
    if (path === 'qa' || url.pathname === '/v1/qa') {
      return route.fulfill({ json: [] });
    }
    // Generic fallback so no fetch dangles.
    return route.fulfill({ status: 200, json: {} });
  });
}

test.describe('UI-2 default route', () => {
  test('first-login redirect lands on /quick when no pref is set', async ({ page, context }) => {
    await context.clearCookies();
    await setupMocks(page);
    // Wipe any prior persisted pref before the app boots so the test
    // simulates a truly fresh login.
    await page.addInitScript(key => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // localStorage may be disabled in some test environments — fine.
      }
    }, MODE_KEY);

    await page.goto('/');
    await page.waitForURL('**/quick');
    expect(new URL(page.url()).pathname).toBe('/quick');
  });

  test('advanced pref sticks across visits to /', async ({ page }) => {
    await setupMocks(page);
    // Pre-seed the pref before any app code runs so the very first
    // navigation to `/` exercises the persisted branch.
    await page.addInitScript(key => {
      try {
        window.localStorage.setItem(key, 'advanced');
      } catch {
        // ignore
      }
    }, MODE_KEY);

    await page.goto('/');
    await page.waitForURL('**/dashboard');
    expect(new URL(page.url()).pathname).toBe('/dashboard');

    // Second visit to `/` in the same session must still honour the
    // pref — i.e. the guard reads localStorage every time, never
    // caches the decision.
    await page.goto('/');
    await page.waitForURL('**/dashboard');
    expect(new URL(page.url()).pathname).toBe('/dashboard');

    // Confirm the persisted value is still present (sanity: nothing
    // wiped it during navigation).
    const stored = await page.evaluate(k => window.localStorage.getItem(k), MODE_KEY);
    expect(stored).toBe('advanced');
  });

  test('quick pref also lands on /quick', async ({ page }) => {
    await setupMocks(page);
    await page.addInitScript(key => {
      try {
        window.localStorage.setItem(key, 'quick');
      } catch {
        // ignore
      }
    }, MODE_KEY);

    await page.goto('/');
    await page.waitForURL('**/quick');
    expect(new URL(page.url()).pathname).toBe('/quick');
  });
});
