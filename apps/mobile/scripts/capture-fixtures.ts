// Records real API responses for the scripted-day test (slice-15 §9, slice-16 §14, R160): run
// against the dev API, commit the output. Node 24 runs this file directly (type stripping), no
// build step.
//
// Slice 15's leg (a principal's morning), into __tests__/fixtures/scripted-day.json:
//   pnpm --filter @asms/api seed:dev-school          (a school and principal to sign in as)
//   ASMS_API=http://127.0.0.1:3461 ASMS_SCHOOL=demo ASMS_USERNAME=<13 digits> ASMS_PASSWORD=<pw> \
//     pnpm --filter @asms/mobile capture:fixtures
//
// Slice 16's teacher legs, into __tests__/fixtures/scripted-day-teacher.json, against the
// classroom fixture (DEV_SCHOOL_CLASSROOM=1: 30 students in 5 A, the teacher class teacher of 5 A
// and English teacher of 5 B; slice-16 §15.3). It records, as the teacher: sign-in, /me, this
// month's calendar, the device registration, today's 5 A register view (unrecorded), its full
// submit (two absent), the view again (recorded), this week's 5 A diary and a new 5 B diary
// entry. Run it once on a fresh classroom (a second run's submit is a replay and the diary
// entry exists):
//   ASMS_SCHOOL=<code> ASMS_TEACHER_USERNAME=<13 digits> pnpm --filter @asms/mobile capture:fixtures
//
// The output keeps sizes and shapes; identity numbers never appear in a response (R165), the
// bearer token is replaced by a same-length placeholder, and the request bodies are rebuilt by
// the test, so no credential is written to disk.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env as Record<string, string | undefined>;
const base = env.ASMS_API ?? 'http://127.0.0.1:3461';
const schoolCode = env.ASMS_SCHOOL ?? 'demo';
const APP_VERSION = '0.1.0';

type Exchange = {
  method: string;
  path: string;
  status: number;
  body: unknown;
  /** The response headers a test replays (Preference-Applied), when present. */
  headers?: Record<string, string>;
};

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Exchange> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-App-Version': APP_VERSION,
    ...extra,
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const preference = response.headers.get('Preference-Applied');
  return {
    method,
    path,
    status: response.status,
    body: text === '' ? null : (JSON.parse(text) as unknown),
    ...(preference === null ? {} : { headers: { 'Preference-Applied': preference } }),
  };
}

async function signIn(
  username: string,
  password: string,
): Promise<{ login: Exchange; token: string }> {
  const login = await call('POST', '/api/v1/auth/login', null, {
    schoolCode,
    username,
    password,
    channel: 'bearer',
  });
  if (login.status !== 200) throw new Error(`login answered ${login.status}`);
  const token = (login.body as { bearerToken: string }).bearerToken;
  return {
    login: { ...login, body: { ...(login.body as object), bearerToken: 'T'.repeat(token.length) } },
    token,
  };
}

function write(file: string, exchanges: Exchange[]): void {
  const out = join(import.meta.dirname, '..', '__tests__', 'fixtures', file);
  writeFileSync(
    out,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), base: 'dev API', exchanges }, null, 2)}\n`,
  );
  console.log(`wrote ${exchanges.length} exchanges to ${out}`);
}

function expect(exchange: Exchange, status: number): Exchange {
  if (exchange.status !== status) {
    throw new Error(
      `${exchange.method} ${exchange.path.split('?')[0]} answered ${exchange.status}`,
    );
  }
  return exchange;
}

/** Slice 15: the principal's sign-in, /me, the calendar and the device registration. */
async function principalDay(username: string, password: string): Promise<void> {
  const { login, token } = await signIn(username, password);
  const exchanges: Exchange[] = [
    login,
    await call('GET', '/api/v1/me', token),
    await call('GET', '/api/v1/me/calendar?dateFrom=2026-10-01&dateTo=2026-10-31', token),
    await call('POST', '/api/v1/me/devices', token, {
      platform: 'android',
      pushToken: `fixture-${'x'.repeat(140)}`,
    }),
  ];
  await call('POST', '/api/v1/auth/logout', token);
  write('scripted-day.json', exchanges);
}

type Assignment = {
  role: string;
  sectionId: string | null;
  subjectId: string | null;
};

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());

function mondayOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/** Slice 16: the teacher's register and diary legs on a 30-student roster (§14). */
async function teacherDay(username: string): Promise<void> {
  const { login, token } = await signIn(username, env.ASMS_TEACHER_PASSWORD ?? username);
  const me = expect(await call('GET', '/api/v1/me', token), 200);
  const assignments = (me.body as { assignments: Assignment[] }).assignments;
  const sectionA = assignments.find((a) => a.role === 'class_teacher')?.sectionId;
  const sectionB = assignments.find((a) => a.role === 'subject_teacher');
  if (!sectionA || !sectionB?.sectionId || !sectionB.subjectId) {
    throw new Error('The teacher has no classroom: seed it with DEV_SCHOOL_CLASSROOM=1');
  }
  const date = today();
  const month = date.slice(0, 7);
  const registerPath = `/api/v1/sections/${sectionA}/register?date=${date}&period=1`;
  const view = expect(await call('GET', registerPath, token), 200);
  const roster = (view.body as { roster: { enrolmentId: string; onRoster: boolean }[] }).roster;
  const marks = roster
    .filter((row) => row.onRoster)
    .map((row, i) => ({ enrolmentId: row.enrolmentId, status: i < 2 ? 'absent' : 'present' }));

  const exchanges: Exchange[] = [
    login,
    me,
    await call('GET', `/api/v1/me/calendar?dateFrom=${month}-01&dateTo=${month}-31`, token),
    await call('POST', '/api/v1/me/devices', token, {
      platform: 'android',
      pushToken: `fixture-${'x'.repeat(140)}`,
    }),
    view,
    expect(
      await call('POST', `/api/v1/sections/${sectionA}/submit-register`, token, {
        date,
        period: 1,
        marks,
      }),
      201,
    ),
    // The same view once the register exists: what a refetch after "Saved on server" returns.
    { ...expect(await call('GET', registerPath, token), 200), path: `${registerPath}#recorded` },
    await call(
      'GET',
      `/api/v1/sections/${sectionA}/diary-entries?dateFrom=${mondayOf(date)}&dateTo=${date}&limit=25&page=1`,
      token,
    ),
    expect(
      await call(
        'POST',
        `/api/v1/sections/${sectionB.sectionId}/diary-entries`,
        token,
        { date, subjectId: sectionB.subjectId, topic: 'Pages 12–14', assignment: 'Exercise 4' },
        { 'Idempotency-Key': randomUUID() },
      ),
      201,
    ),
  ];
  await call('POST', '/api/v1/auth/logout', token);
  write('scripted-day-teacher.json', exchanges);
}

/**
 * Slice 16b: the inbox leg (§14), into __tests__/fixtures/scripted-day-inbox.json — one page of
 * GET /me/inbox as the person signed in. Separate from the teacher's day so it can be recorded
 * again without a fresh classroom:
 *   ASMS_SCHOOL=<code> ASMS_INBOX_USERNAME=<13 digits> pnpm --filter @asms/mobile capture:fixtures
 */
async function inboxLeg(username: string): Promise<void> {
  const { token } = await signIn(username, env.ASMS_INBOX_PASSWORD ?? username);
  const exchanges = [expect(await call('GET', '/api/v1/me/inbox?limit=25&page=1', token), 200)];
  await call('POST', '/api/v1/auth/logout', token);
  write('scripted-day-inbox.json', exchanges);
}

/**
 * Slice 16b (R160): the register submit as the app sends it — `Prefer: return=minimal` — into
 * __tests__/fixtures/scripted-day-submit.json: the 5 A register view of the latest unrecorded
 * teaching day in the last fortnight, and its full-roster submit (two absent). With no such day
 * (a classroom whose year began today, already recorded), today's register is submitted again
 * with the marks it holds: the same full-roster body, answered 200 with every mark `unchanged` —
 * the same shape and size. Each run can be repeated without a fresh classroom:
 *   ASMS_SCHOOL=<code> ASMS_SUBMIT_USERNAME=<13 digits> pnpm --filter @asms/mobile capture:fixtures
 */
async function submitLeg(username: string): Promise<void> {
  const { token } = await signIn(username, env.ASMS_TEACHER_PASSWORD ?? username);
  const me = expect(await call('GET', '/api/v1/me', token), 200);
  const sectionA = (me.body as { assignments: Assignment[] }).assignments.find(
    (a) => a.role === 'class_teacher',
  )?.sectionId;
  if (!sectionA) throw new Error('The teacher has no classroom: seed it with DEV_SCHOOL_CLASSROOM=1');
  type View = {
    register: unknown;
    teachingDay: boolean;
    canSubmit: boolean;
    roster: { enrolmentId: string; onRoster: boolean; mark: { status: string } | null }[];
  };
  const record = async (view: Exchange, date: string, marks: unknown[], status: number) => {
    const submit = expect(
      await call(
        'POST',
        `/api/v1/sections/${sectionA}/submit-register`,
        token,
        { date, period: 1, marks },
        { Prefer: 'return=minimal' },
      ),
      status,
    );
    if (submit.headers?.['Preference-Applied'] !== 'return=minimal') {
      throw new Error('the API did not apply Prefer: return=minimal');
    }
    await call('POST', '/api/v1/auth/logout', token);
    write('scripted-day-submit.json', [view, submit]);
  };
  for (let back = 0; back < 14; back += 1) {
    const date = new Date(Date.parse(`${today()}T00:00:00Z`) - back * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const view = await call('GET', `/api/v1/sections/${sectionA}/register?date=${date}&period=1`, token);
    const body = view.body as View;
    if (view.status !== 200 || body.register !== null || !body.teachingDay || !body.canSubmit) continue;
    const marks = body.roster
      .filter((row) => row.onRoster)
      .map((row, i) => ({ enrolmentId: row.enrolmentId, status: i < 2 ? 'absent' : 'present' }));
    await record(view, date, marks, 201);
    return;
  }
  const date = today();
  const view = expect(
    await call('GET', `/api/v1/sections/${sectionA}/register?date=${date}&period=1`, token),
    200,
  );
  const body = view.body as View;
  const marks = body.roster
    .filter((row) => row.onRoster && row.mark !== null)
    .map((row) => ({ enrolmentId: row.enrolmentId, status: row.mark!.status }));
  if (marks.length === 0) throw new Error('No register for 5 A to record');
  await record(view, date, marks, 200);
}

async function main(): Promise<void> {
  const username = env.ASMS_USERNAME;
  const teacher = env.ASMS_TEACHER_USERNAME;
  const inbox = env.ASMS_INBOX_USERNAME;
  const submit = env.ASMS_SUBMIT_USERNAME;
  if (
    username === undefined &&
    teacher === undefined &&
    inbox === undefined &&
    submit === undefined
  ) {
    console.error(
      'Set ASMS_USERNAME (principal), ASMS_TEACHER_USERNAME (classroom teacher), ' +
        'ASMS_INBOX_USERNAME and/or ASMS_SUBMIT_USERNAME.',
    );
    process.exit(1);
  }
  for (const digits of [username, teacher, inbox, submit]) {
    if (digits !== undefined && !/^\d{13}$/.test(digits)) {
      console.error('A username is the 13 digits of the identity number.');
      process.exit(1);
    }
  }
  if (username !== undefined) await principalDay(username, env.ASMS_PASSWORD ?? username);
  if (teacher !== undefined) await teacherDay(teacher);
  if (inbox !== undefined) await inboxLeg(inbox);
  if (submit !== undefined) await submitLeg(submit);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed');
  process.exit(1);
});
