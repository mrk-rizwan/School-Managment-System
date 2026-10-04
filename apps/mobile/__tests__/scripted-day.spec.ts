import { api, unwrap, unwrapWithDate } from '../src/api/client';
import { signIn } from '../src/auth/sign-in';
import { enqueue } from '../src/db/outbox.repository';
import { OutboxWorker } from '../src/outbox/worker';
import { sendItem } from '../src/outbox/runtime';
import * as outbox from '../src/db/outbox.repository';
import { installFakeApi, resetDevice, type Handler } from '../src/test/fake-api';
import fixtures from './fixtures/scripted-day.json';

// R160, R166 (slice-15 §9): a scripted day through the real client, served from responses
// recorded from the dev API (scripts/capture-fixtures.ts), so the sizes are real. Slice 15 runs
// its subset — sign-in, /me, the calendar, device registration; slice 16 adds three registers, a
// diary entry and an inbox refresh, and keeps the budget.

const BUDGET_BYTES = 50 * 1024;
const HEADER_ALLOWANCE = 300;
const MAX_REQUESTS = 60;

type Exchange = { method: string; path: string; status: number; body: unknown };

function served(): Record<string, Handler> {
  const routes: Record<string, Handler> = {};
  for (const exchange of fixtures.exchanges as Exchange[]) {
    const path = exchange.path.split('?')[0]!;
    routes[`${exchange.method} ${path}`] = () => ({ status: exchange.status, body: exchange.body });
  }
  return routes;
}

beforeEach(resetDevice);

test('the fixtures are real recordings with no identity number in them', () => {
  const text = JSON.stringify(fixtures);
  expect(fixtures.exchanges.length).toBeGreaterThanOrEqual(4);
  expect(text).not.toMatch(/\d{5}-?\d{7}-?\d/);
});

test("slice 15's day: under 50 KB excluding images, within the per-session throttle, no image fetched", async () => {
  const fake = installFakeApi(served());

  // Morning: sign in (the login result is /me), the app's own refresh of /me, this month's
  // calendar, and the push registration through the outbox.
  const login = fixtures.exchanges[0] as Exchange;
  const result = await signIn({
    schoolCode: 'demo',
    identity: '3520276543213',
    password: '3520276543213', // pragma: allowlist secret (the seeded fixture's default password)
  });
  expect(result.ok).toBe(true);
  expect(login.status).toBe(200);
  await unwrapWithDate(api.GET('/api/v1/me'));
  await unwrap(
    api.GET('/api/v1/me/calendar', {
      params: { query: { dateFrom: '2026-10-01', dateTo: '2026-10-31' } },
    }),
  );
  await enqueue({
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
    body: { platform: 'android', pushToken: `fixture-${'x'.repeat(140)}` },
  });
  const worker = new OutboxWorker({ store: outbox, send: sendItem, isOnline: () => true });
  await worker.trigger('sign_in');
  await worker.idle();

  const requests = fake.traffic.length;
  const bytes = fake.traffic.reduce(
    (sum, t) => sum + t.requestBytes + t.responseBytes + HEADER_ALLOWANCE,
    0,
  );
  expect(requests).toBe(4);
  expect(requests).toBeLessThanOrEqual(MAX_REQUESTS);
  expect(bytes).toBeLessThan(BUDGET_BYTES);
  for (const call of fake.calls) expect(call.path).not.toMatch(/\/(thumbnail|attachment)$/);
});
