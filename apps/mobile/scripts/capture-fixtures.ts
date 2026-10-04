// Records real API responses for the scripted-day test (slice-15 §9, R160): run once against the
// dev API, commit the output. Node 24 runs this file directly (type stripping), no build step.
//
//   pnpm --filter @asms/api seed:dev-school          (a school and principal to sign in as)
//   ASMS_API=http://127.0.0.1:3461 ASMS_SCHOOL=demo ASMS_USERNAME=<13 digits> ASMS_PASSWORD=<pw> \
//     pnpm --filter @asms/mobile capture:fixtures
//
// The output keeps sizes and shapes; identity numbers never appear in a response (R165), the
// bearer token is replaced by a same-length placeholder, and the request bodies are rebuilt by
// the test, so no credential is written to disk.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env as Record<string, string | undefined>;
const base = env.ASMS_API ?? 'http://127.0.0.1:3461';
const schoolCode = env.ASMS_SCHOOL ?? 'demo';
const username = env.ASMS_USERNAME ?? '';
const password = env.ASMS_PASSWORD ?? username;
const APP_VERSION = '0.1.0';

if (!/^\d{13}$/.test(username)) {
  console.error('Set ASMS_USERNAME to the 13 digits of the seeded principal.');
  process.exit(1);
}

type Exchange = { method: string; path: string; status: number; body: unknown };

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Exchange> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-App-Version': APP_VERSION,
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    method,
    path,
    status: response.status,
    body: text === '' ? null : (JSON.parse(text) as unknown),
  };
}

async function main(): Promise<void> {
  const login = await call('POST', '/api/v1/auth/login', null, {
    schoolCode,
    username,
    password,
    channel: 'bearer',
  });
  if (login.status !== 200) throw new Error(`login answered ${login.status}`);
  const token = (login.body as { bearerToken: string }).bearerToken;

  const exchanges: Exchange[] = [
    { ...login, body: { ...(login.body as object), bearerToken: 'T'.repeat(token.length) } },
    await call('GET', '/api/v1/me', token),
    await call('GET', '/api/v1/me/calendar?dateFrom=2026-10-01&dateTo=2026-10-31', token),
    await call('POST', '/api/v1/me/devices', token, {
      platform: 'android',
      pushToken: `fixture-${'x'.repeat(140)}`,
    }),
  ];
  await call('POST', '/api/v1/auth/logout', token);

  const out = join(import.meta.dirname, '..', '__tests__', 'fixtures', 'scripted-day.json');
  writeFileSync(
    out,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), base: 'dev API', exchanges }, null, 2)}\n`,
  );
  console.log(`wrote ${exchanges.length} exchanges to ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed');
  process.exit(1);
});
