import { expect, test } from '@playwright/test';

test('/ redirects to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('login page shows the three fields', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel('School code')).toBeVisible();
  await expect(page.getByLabel('CNIC or B-Form number')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('pages carry the security headers', async ({ request }) => {
  const response = await request.get('/login');
  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+'/);
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');
});

test('a page whose path merely starts with "api" still carries the CSP', async ({ request }) => {
  // The proxy matcher excludes /api/ (the proxied JSON API), not every path beginning "api".
  const response = await request.get('/api-docs-not-real');
  expect(response.status()).toBe(404);
  expect(response.headers()['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+'/);
});

test('the proxied API is not given a page CSP', async ({ request }) => {
  const response = await request.get('/api/v1/health');
  expect(response.headers()['content-security-policy']).toBeUndefined();
});

test('demo page renders the table with rows', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.goto('/demo');
  const table = page.getByRole('table');
  await expect(table).toBeVisible();
  // 1 header row + 10 rows on the first page.
  await expect(table.getByRole('row')).toHaveCount(11);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText('Showing 11–20 of 23')).toBeVisible();
  // The page hydrated under the CSP: a blocked script would have left the button inert.
  expect(consoleErrors.filter((e) => e.includes('Content Security Policy'))).toEqual([]);
});
