import { todayInSchool } from '@asms/shared';
import { api, unwrap, unwrapWithDate } from '../src/api/client';
import { signIn } from '../src/auth/sign-in';
import { saveDiaryEntry, saveRegister } from '../src/db/local.repository';
import { enqueue, listByState } from '../src/db/outbox.repository';
import { OutboxWorker } from '../src/outbox/worker';
import { onSaved, sendItem } from '../src/outbox/runtime';
import * as outbox from '../src/db/outbox.repository';
import { installFakeApi, resetDevice, type Handler } from '../src/test/fake-api';
import fixtures from './fixtures/scripted-day.json';
import teacherFixtures from './fixtures/scripted-day-teacher.json';
import inboxFixtures from './fixtures/scripted-day-inbox.json';
import submitFixtures from './fixtures/scripted-day-submit.json';
import { QueryObserver } from '@tanstack/react-query';
import { queryClient } from '../src/api/query-client';
import { queryKeys } from '../src/api/query-keys';
import { asOf } from '../src/db/cache';

// R160, R166 (slice-15 §9): a scripted day through the real client, served from responses
// recorded from the dev API (scripts/capture-fixtures.ts), so the sizes are real. Slice 15 runs
// its subset — sign-in, /me, the calendar, device registration; slice 16 adds the teacher's day
// (three registers and the diary) below and keeps the budget; 16b adds the inbox.

const BUDGET_BYTES = 50 * 1024;
/**
 * Headers per round trip, both ways (review L1): request (Authorization, X-App-Version, Accept,
 * Content-Type, Host, User-Agent) and response (Date, Content-Type, Content-Length, ETag,
 * X-Request-Id, Cache-Control, security headers) come to about 700 bytes uncompressed.
 */
const HEADER_ALLOWANCE = 700;
const MAX_REQUESTS = 60;

type Exchange = {
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

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

// slice-16 §14: the teacher's day on a real 30-student roster (the classroom fixture), recorded
// from the dev API by scripts/capture-fixtures.ts: sign-in, /me, the calendar, the device
// registration, three registers (each opened, then saved through the submit_register lane:
// three distinct natural keys, so no coalescing on the critical path), the week's diary and one
// new diary entry through the diary_entry lane. The budget is not edited to pass (decision 5).

type Recording = { exchanges: Exchange[] };
const teacher = teacherFixtures as Recording;

type InboxPage = { data: Record<string, unknown>[]; page: number; limit: number; total: number };

/**
 * A full inbox page of 25 (review L1). SYNTHETIC: the recording (scripted-day-inbox.json, real
 * GET /me/inbox from the dev API) holds three items; each of the 25 here is one of those three,
 * its shape and text unchanged, with its own id — so the page is as large as a busy inbox's
 * first page would be, without inventing a field.
 */
function fullInboxPage(): InboxPage {
  const recorded = (inboxFixtures as Recording).exchanges[0]!.body as InboxPage;
  const data = Array.from({ length: 25 }, (_, i) => ({
    ...recorded.data[i % recorded.data.length]!,
    id: String(1000 + i),
  }));
  return { data, page: 1, limit: 25, total: 60 };
}

/**
 * The submit as the app now sends it, `Prefer: return=minimal` (R160): recorded from the dev API
 * into scripted-day-submit.json (scripts/capture-fixtures.ts, ASMS_SUBMIT_USERNAME). The
 * classroom's only teaching day was already recorded, so the recording is today's 30-mark
 * register submitted again: answered 200, every mark `unchanged` — the same shape and size as a
 * first submit's 201. Replayed with its Preference-Applied header.
 */
function minimalSubmit(): Handler {
  const submit = (submitFixtures as Recording).exchanges[1]!;
  return () => ({ status: 201, body: submit.body, headers: submit.headers });
}

function teacherRoutes(): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    'GET /api/v1/me/inbox': () => ({ status: 200, body: fullInboxPage() }),
  };
  const sectionPath = (submitFixtures as Recording).exchanges[1]!.path;
  routes[`POST ${sectionPath}`] = minimalSubmit();
  for (const exchange of teacher.exchanges) {
    if (exchange.path.endsWith('#recorded')) continue;
    const path = exchange.path.split('?')[0]!;
    routes[`${exchange.method} ${path}`] ??= () => ({
      status: exchange.status,
      body: exchange.body,
    });
  }
  return routes;
}

function bytesOf(fake: { traffic: { requestBytes: number; responseBytes: number }[] }): number {
  return fake.traffic.reduce(
    (sum, t) => sum + t.requestBytes + t.responseBytes + HEADER_ALLOWANCE,
    0,
  );
}

test('the teacher fixtures are real recordings of a 30-student roster with no identity number or phone', () => {
  const text = JSON.stringify([teacherFixtures, inboxFixtures, submitFixtures]);
  expect(text).not.toMatch(/\d{5}-?\d{7}-?\d/);
  expect(text).not.toMatch(/(\+?92[\s-]?|0)3\d{2}[\s-]?\d{7}/);
  const view = teacher.exchanges.find(
    (e) => e.method === 'GET' && /\/register$/.test(e.path.split('?')[0]!),
  )!;
  expect((view.body as { roster: unknown[] }).roster).toHaveLength(30);
});

test("the teacher's day: under 50 KB excluding images, at most 60 requests, no image fetched", async () => {
  const fake = installFakeApi(teacherRoutes());
  const login = teacher.exchanges[0]!;
  const result = await signIn({
    schoolCode: 'ciroom',
    identity: '3520299999992',
    password: '3520299999992', // pragma: allowlist secret (the classroom fixture's default password)
  });
  expect(result.ok).toBe(true);
  expect(login.status).toBe(200);
  const me = (await unwrapWithDate(api.GET('/api/v1/me'))).data;
  const today = todayInSchool();
  await unwrap(
    api.GET('/api/v1/me/calendar', {
      params: { query: { dateFrom: `${today.slice(0, 7)}-01`, dateTo: `${today.slice(0, 7)}-31` } },
    }),
  );
  await enqueue({
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
    body: { platform: 'android', pushToken: `fixture-${'x'.repeat(140)}` },
  });
  const worker = new OutboxWorker({ store: outbox, send: sendItem, isOnline: () => true, onSaved });
  await worker.trigger('sign_in');
  await worker.idle();

  // Three registers: opened (the roster), marked (pre-filled present, two absent), saved.
  const screens: (() => void)[] = [];
  const sectionA = me.assignments.find((a) => a.role === 'class_teacher')!.sectionId!;
  for (const back of [2, 1, 0]) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000)
      .toISOString()
      .slice(0, 10);
    // The register screen is open on this view (an active query) while the save reaches the
    // server: R160's decision is that "Saved on server" updates it from the submit response,
    // so an invalidation would show up here as a second GET of the roster.
    const fetchView = () =>
      unwrapWithDate(
        api.GET('/api/v1/sections/{id}/register', {
          params: { path: { id: sectionA }, query: { date, period: 1 } },
        }),
      ).then(({ data, date: header }) => ({ body: data, ...asOf(header) }));
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.register(sectionA, date, 1),
      queryFn: fetchView,
      staleTime: 0,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    const view = (await observer.refetch()).data!.body;
    screens.push(unsubscribe);
    await saveRegister({
      sectionId: sectionA,
      date,
      period: 1,
      mode: 'new',
      marks: view.roster
        .filter((row) => row.onRoster)
        .map((row, i) => ({ enrolmentId: row.enrolmentId, status: i < 2 ? 'absent' : 'present' })),
    });
    await worker.trigger('enqueued');
    await worker.idle();
  }
  expect(await listByState('done')).toHaveLength(4);

  // The week's diary, then one new entry.
  await unwrap(
    api.GET('/api/v1/sections/{id}/diary-entries', {
      params: {
        path: { id: sectionA },
        query: { dateFrom: today, dateTo: today, limit: 25, page: 1 },
      },
    }),
  );
  const sectionB = me.assignments.find((a) => a.role === 'subject_teacher')!;
  await saveDiaryEntry(
    sectionB.sectionId!,
    { date: today, subjectId: sectionB.subjectId!, topic: 'Pages 12–14', assignment: 'Exercise 4' },
    null,
  );
  await worker.trigger('enqueued');
  await worker.idle();
  expect(await listByState('done')).toHaveLength(5);

  // The inbox, once (16b).
  await unwrap(api.GET('/api/v1/me/inbox', { params: { query: { limit: 25, page: 1 } } }));
  for (const close of screens) close();

  const requests = fake.traffic.length;
  const bytes = bytesOf(fake);
  const registerReads = fake.calls.filter((c) => /\/register$/.test(c.path)).length;
  // The measured figure, for the build report (slice-16 §14).
  process.stdout.write(
    `scripted day (teacher, 30 students, register screen open through each save, a full inbox page; ` +
      `${HEADER_ALLOWANCE} B headers per round trip): ` +
      `${requests} requests, ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)\n`,
  );
  // Where the bytes go, by endpoint (ids folded), for the build report.
  const byEndpoint = new Map<string, number>();
  for (const t of fake.traffic) {
    const endpoint = t.path.replace(/\/\d+(?=\/|$)/g, '/:id');
    byEndpoint.set(
      endpoint,
      (byEndpoint.get(endpoint) ?? 0) + t.requestBytes + t.responseBytes + HEADER_ALLOWANCE,
    );
  }
  process.stdout.write(
    `${[...byEndpoint].sort((x, y) => y[1] - x[1]).map(([e, n]) => `  ${e}: ${n}`).join('\n')}\n`,
  );
  // Three roster reads for three registers: none refetched after "Saved on server".
  expect(registerReads).toBe(3);
  // Every submit asked for, and got, the minimal answer.
  const submits = fake.calls.filter((c) => c.path.endsWith('/submit-register'));
  expect(submits).toHaveLength(3);
  for (const call of submits) expect(call.headers.get('Prefer')).toBe('return=minimal');
  expect(requests).toBe(13);
  expect(requests).toBeLessThanOrEqual(MAX_REQUESTS);
  expect(bytes).toBeLessThan(BUDGET_BYTES);
  for (const call of fake.calls) expect(call.path).not.toMatch(/\/(thumbnail|attachment)$/);
});
