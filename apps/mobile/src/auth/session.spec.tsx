import { ErrorCode, formatDate } from '@asms/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SignInScreen from '../app/sign-in';
import { queryClient } from '../api/query-client';
import { cacheKey, readCache, writeCache } from '../db/cache';
import * as cache from '../db/cache';
import { DATABASE_NAME, getDb, META, setMeta, UNSENT_WINDOW_MS } from '../db/database';
import { enqueue, listByState, listUnfinished, saveItem } from '../db/outbox.repository';
import { transition } from '../outbox/machine';
import { logText } from '../platform/log';
import {
  errorBody,
  installFakeApi,
  loginFixture,
  meFixture,
  resetDevice,
  SERVER_DATE,
  type Handler,
} from '../test/fake-api';
import { IDENTITY_PATTERN, PHONE_PATTERN, TOKEN_PATTERN } from '../test/patterns';
import { secureStoreContents } from '../test/secure-store';
import { databaseFileExists, filesStartingWith } from '../test/sqlite-adapter';
import { SessionProvider, useSession } from './session';
import * as sessionStore from './session-store';
import { KEYS, writeSession } from './session-store';
import { signIn } from './sign-in';

// slice-15 §4, §7.6, §13.1 (auth/session.spec.tsx): the real provider, store, database and
// client against a fake API.

const TOKEN = 'T'.repeat(43);
const NEW_TOKEN = 'N'.repeat(43);
const CNIC = '3520112345671';

let current: ReturnType<typeof useSession> | null = null;
function Probe() {
  current = useSession();
  return null;
}
const session = () => current!;

const registerPush = jest.fn(() => Promise.resolve('skipped_no_firebase' as const));

function mount(withSignIn = true) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider registerPush={registerPush}>
        <Probe />
        {withSignIn ? <SignInScreen /> : null}
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'POST /api/v1/auth/login': () => ({
      status: 200,
      body: loginFixture(TOKEN, { passwordIsDefault: true }),
    }),
    'GET /api/v1/me': () => ({ status: 200, body: meFixture({ passwordIsDefault: true }) }),
    'POST /api/v1/auth/logout': () => ({ status: 204 }),
    ...extra,
  };
}

async function signInThroughTheScreen(identity = '35201-1234567-1') {
  await waitFor(() => expect(session().status).toBe('signed-out'));
  fireEvent.changeText(screen.getByTestId('signIn.schoolCode'), 'Demo');
  const field = screen.queryByTestId('signIn.identity');
  if (field) fireEvent.changeText(field, identity);
  fireEvent.changeText(screen.getByTestId('signIn.password'), 'secret-pass');
  await act(async () => {
    fireEvent.press(screen.getByTestId('signIn.submit'));
  });
  await waitFor(() => expect(session().status).toBe('signed-in'));
}

beforeEach(async () => {
  await resetDevice();
  current = null;
});

afterEach(() => {
  queryClient.clear();
});

test('sign-in writes the secure store and the cache, and sends a bearer login', async () => {
  const fake = installFakeApi(routes());
  mount();
  await signInThroughTheScreen();

  const login = fake.calls.find((c) => c.path === '/api/v1/auth/login')!;
  expect(login.body).toEqual({
    schoolCode: 'demo',
    username: CNIC,
    password: 'secret-pass', // pragma: allowlist secret
    channel: 'bearer',
  }); // pragma: allowlist secret
  expect(login.headers.get('X-App-Version')).toBe('0.1.0');
  expect(login.headers.has('Origin')).toBe(false);

  expect(secureStoreContents()).toEqual({
    [KEYS.token]: TOKEN,
    [KEYS.userId]: '41',
    [KEYS.schoolId]: '7',
    [KEYS.schoolCode]: 'demo',
    [KEYS.username]: CNIC,
  });
  const cachedMe = await readCache<Record<string, unknown>>(cacheKey('/api/v1/me'));
  expect(cachedMe?.body.fullName).toBe('Ayesha Khan');
  expect(cachedMe?.body).not.toHaveProperty('bearerToken');
  expect(cachedMe?.serverTime).toBe(new Date(SERVER_DATE).toISOString());
  expect(session().me?.body.passwordIsDefault).toBe(true);
  expect(registerPush).toHaveBeenCalledTimes(1);
});

test('a wrong password: one generic sentence, the password cleared', async () => {
  installFakeApi(
    routes({
      'POST /api/v1/auth/login': () => ({
        status: 401,
        body: errorBody(
          ErrorCode.AUTH_FAILED,
          'The school code, username or password is incorrect.',
        ),
      }),
    }),
  );
  mount();
  await waitFor(() => expect(session().status).toBe('signed-out'));
  fireEvent.changeText(screen.getByTestId('signIn.schoolCode'), 'demo');
  fireEvent.changeText(screen.getByTestId('signIn.identity'), CNIC);
  fireEvent.changeText(screen.getByTestId('signIn.password'), 'wrong');
  await act(async () => {
    fireEvent.press(screen.getByTestId('signIn.submit'));
  });
  expect(await screen.findByTestId('signIn.error')).toHaveTextContent(
    'The school code, username or password is incorrect.',
  );
  expect(screen.getByTestId('signIn.password').props.value).toBe('');
  expect(secureStoreContents()).toEqual({});
});

test('the old token is presented on re-login', async () => {
  const fake = installFakeApi(routes());
  await writeSession({ token: 'O'.repeat(43), userId: '41', schoolId: '7' });
  await signIn({ schoolCode: 'demo', identity: CNIC, password: 'x' });
  const login = fake.calls.find((c) => c.path === '/api/v1/auth/login')!;
  expect(login.headers.get('Authorization')).toBe(`Bearer ${'O'.repeat(43)}`);
  expect(secureStoreContents()[KEYS.token]).toBe(TOKEN);
});

test('a 401 → sign-in screen: token and caches gone, pending rows kept for the same user (§7.6)', async () => {
  let meStatus = 200;
  installFakeApi(
    routes({
      'GET /api/v1/me': () =>
        meStatus === 200
          ? { status: 200, body: meFixture() }
          : { status: 401, body: errorBody(ErrorCode.AUTH_REQUIRED, 'Your session has ended.') },
      'POST /api/v1/me/devices': () => 'network',
    }),
  );
  mount();
  await signInThroughTheScreen();

  await writeCache(
    cacheKey('/api/v1/me/calendar', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }),
    { holidays: [] },
    null,
  );
  const pendingId = await enqueue({
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
    body: { platform: 'android', pushToken: 'p1' },
  });
  const doneId = await enqueue({
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
    body: { platform: 'android', pushToken: 'p0' },
  });
  const [doneRow] = (await listByState('pending')).filter((r) => r.id === doneId);
  const sent = transition(transition(doneRow!, { type: 'send', now: new Date() }).item, {
    type: 'outcome',
    outcome: { kind: 'response', status: 201, code: null, message: null, retryAfterSeconds: null },
    now: new Date(),
  }).item;
  await saveItem(sent);

  meStatus = 401;
  await act(async () => {
    await session().refreshMe();
  });
  await waitFor(() => expect(session().status).toBe('signed-out'));

  expect(session().sessionEnded).toBe(true);
  expect(session().unsent).toBe(1);
  expect(secureStoreContents()).toEqual({ [KEYS.schoolCode]: 'demo', [KEYS.username]: CNIC });
  const db = await getDb();
  expect(await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cache')).toEqual({
    n: 0,
  });
  expect((await listUnfinished()).map((r) => r.id)).toEqual([pendingId]);
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  expect(await screen.findByTestId('signIn.notice')).toHaveTextContent(
    /Your session ended. Sign in again. 1 unsent item will be sent after you sign in./,
  );
  expect(screen.getByTestId('signIn.maskedIdentity')).toHaveTextContent('35201-*****-1');

  // The same user signs in again: the pending row survives.
  meStatus = 200;
  fireEvent.changeText(screen.getByTestId('signIn.password'), 'secret-pass');
  await act(async () => {
    fireEvent.press(screen.getByTestId('signIn.submit'));
  });
  await waitFor(() => expect(session().status).toBe('signed-in'));
  expect((await listUnfinished()).map((r) => r.id)).toContain(pendingId);
});

test('a different user signing in after a 401 → full wipe of the device rows', async () => {
  installFakeApi(routes({ 'POST /api/v1/me/devices': () => 'network' }));
  await signIn({ schoolCode: 'demo', identity: CNIC, password: 'x' });
  await enqueue({
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
    body: { platform: 'android', pushToken: 'p1' },
  });
  installFakeApi(
    routes({
      'POST /api/v1/auth/login': () => ({ status: 200, body: loginFixture(TOKEN, { id: '99' }) }),
    }),
  );
  await signIn({ schoolCode: 'demo', identity: '3520199999991', password: 'x' });
  expect(await listUnfinished()).toEqual([]);
});

test('sign-out: server first, then the wipe — no database file, only the two remembered keys, empty query cache', async () => {
  const fake = installFakeApi(routes());
  mount();
  await signInThroughTheScreen();
  queryClient.setQueryData(['me', 'calendar', 'x', 'y'], { any: 1 });

  let result: string | undefined;
  await act(async () => {
    result = await session().signOut();
  });
  expect(result).toBe('signed_out');
  const logout = fake.calls.find((c) => c.path === '/api/v1/auth/logout')!;
  expect(logout.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
  expect(databaseFileExists(DATABASE_NAME)).toBe(false);
  // M1: no -wal or -shm sibling outlives the file.
  expect(filesStartingWith(DATABASE_NAME)).toEqual([]);
  expect(Object.keys(secureStoreContents()).sort()).toEqual(
    [KEYS.schoolCode, KEYS.username].sort(),
  );
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  expect(session().status).toBe('signed-out');
});

test('sign-out with no connection asks first; "sign out anyway" wipes locally', async () => {
  installFakeApi(routes());
  mount();
  await signInThroughTheScreen();
  installFakeApi(routes({ 'POST /api/v1/auth/logout': () => 'network' }));
  let result: string | undefined;
  await act(async () => {
    result = await session().signOut();
  });
  expect(result).toBe('unreachable');
  expect(session().status).toBe('signed-in');
  await act(async () => {
    result = await session().signOut({ force: true });
  });
  expect(result).toBe('signed_out');
  expect(databaseFileExists(DATABASE_NAME)).toBe(false);
});

test('change-password replaces the token before /me is updated, and later requests use it', async () => {
  const fake = installFakeApi(
    routes({
      'POST /api/v1/me/change-password': () => ({
        status: 200,
        body: loginFixture(NEW_TOKEN, { passwordIsDefault: false }),
      }),
    }),
  );
  mount();
  await signInThroughTheScreen();
  const replace = jest.spyOn(sessionStore, 'replaceToken');
  const write = jest.spyOn(cache, 'writeCache');

  await act(async () => {
    const result = await session().changePassword('secret-pass', 'a-new-password');
    expect(result.ok).toBe(true);
  });
  expect(replace).toHaveBeenCalledWith(NEW_TOKEN);
  expect(replace.mock.invocationCallOrder[0]!).toBeLessThan(write.mock.invocationCallOrder[0]!);
  expect(secureStoreContents()[KEYS.token]).toBe(NEW_TOKEN);
  expect(session().me?.body.passwordIsDefault).toBe(false);

  await act(async () => {
    await session().refreshMe();
  });
  expect(fake.calls.at(-1)!.headers.get('Authorization')).toBe(`Bearer ${NEW_TOKEN}`);
});

test('change-password without a verified email says where to add one', async () => {
  installFakeApi(
    routes({
      'POST /api/v1/me/change-password': () => ({
        status: 409,
        body: errorBody(ErrorCode.EMAIL_NOT_VERIFIED, 'Verify first.'),
      }),
    }),
  );
  mount();
  await signInThroughTheScreen();
  let message = '';
  await act(async () => {
    const result = await session().changePassword('a', 'bbbbbbbb');
    if (!result.ok) message = result.message;
  });
  expect(message).toBe('Add and verify an email on the web first.');
});

test('a 426 at login → blocked, only the update screen', async () => {
  installFakeApi(
    routes({
      'POST /api/v1/auth/login': () => ({
        status: 426,
        body: errorBody(
          ErrorCode.UPGRADE_REQUIRED,
          'This version of the app is no longer supported.',
          { minimumVersion: '99.0.0' },
        ),
      }),
    }),
  );
  mount();
  await waitFor(() => expect(session().status).toBe('signed-out'));
  await act(async () => {
    await session().signIn({ schoolCode: 'demo', identity: CNIC, password: 'x' });
  });
  expect(session().status).toBe('blocked');
  expect(session().upgrade).toEqual({
    minimumVersion: '99.0.0',
    message: 'This version of the app is no longer supported.',
  });
});

test('a user with no capacity lands on no-access', async () => {
  installFakeApi(
    routes({
      'POST /api/v1/auth/login': () => ({
        status: 200,
        body: loginFixture(TOKEN, { capacities: [] }),
      }),
    }),
  );
  mount();
  await waitFor(() => expect(session().status).toBe('signed-out'));
  await act(async () => {
    await session().signIn({ schoolCode: 'demo', identity: CNIC, password: 'x' });
  });
  expect(session().status).toBe('no-access');
});

test('cold start with a stored session renders the cached shell, then refreshes; offline keeps the cache', async () => {
  installFakeApi(routes());
  await signIn({ schoolCode: 'demo', identity: CNIC, password: 'x' });
  installFakeApi(routes({ 'GET /api/v1/me': () => 'network' }));
  mount(false);
  await waitFor(() => expect(session().status).toBe('signed-in'));
  await waitFor(() => expect(session().meStale).toBe(true));
  expect(session().me?.body.fullName).toBe('Ayesha Khan');
});

test('cold start with a session, no cache and no connection → unreachable', async () => {
  await writeSession({ token: TOKEN, userId: '41', schoolId: '7' });
  installFakeApi(routes({ 'GET /api/v1/me': () => 'network' }));
  mount(false);
  await waitFor(() => expect(session().status).toBe('unreachable'));
});

test('R155: after sign-in, a 401 and sign-out, the log holds no identity number, phone or token', async () => {
  let meStatus = 200;
  installFakeApi(
    routes({
      'GET /api/v1/me': () =>
        meStatus === 200
          ? { status: 200, body: meFixture() }
          : { status: 401, body: errorBody(ErrorCode.AUTH_REQUIRED, 'Ended.') },
    }),
  );
  mount();
  await signInThroughTheScreen();
  meStatus = 401;
  await act(async () => {
    await session().refreshMe();
  });
  await waitFor(() => expect(session().status).toBe('signed-out'));
  await signInThroughTheScreen('3520112345671');
  await act(async () => {
    await session().signOut();
  });
  const text = logText();
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(IDENTITY_PATTERN);
  expect(text).not.toMatch(PHONE_PATTERN);
  expect(text).not.toMatch(TOKEN_PATTERN);
});

/** Signs in, leaves one unsent device_register row, and loses the session to a 401. */
async function loseSessionWithOneUnsent(): Promise<{ createdAt: Date }> {
  let meStatus = 200;
  installFakeApi(
    routes({
      'GET /api/v1/me': () =>
        meStatus === 200
          ? { status: 200, body: meFixture() }
          : { status: 401, body: errorBody(ErrorCode.AUTH_REQUIRED, 'Ended.') },
      'POST /api/v1/me/devices': () => 'network',
    }),
  );
  const view = mount();
  await signInThroughTheScreen();
  const createdAt = new Date();
  await enqueue({
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
    body: { platform: 'android', pushToken: 'p1' },
  });
  meStatus = 401;
  await act(async () => {
    await session().refreshMe();
  });
  await waitFor(() => expect(session().status).toBe('signed-out'));
  meStatus = 200;
  view.unmount();
  return { createdAt };
}

const eightDaysAgo = () => new Date(Date.now() - UNSENT_WINDOW_MS - 24 * 60 * 60_000);

test('§7.6: at startup, unsent rows of a session lost over seven days ago are discarded and named', async () => {
  const { createdAt } = await loseSessionWithOneUnsent();
  await setMeta(META.sessionLostAt, eightDaysAgo().toISOString());

  mount(); // the next start
  await waitFor(() => expect(session().status).toBe('signed-out'));
  expect(await listUnfinished()).toEqual([]);
  expect(session().unsent).toBe(0);
  expect(await screen.findByTestId('signIn.discarded')).toHaveTextContent(
    `1 unsent item was discarded because your session ended: Notification registration (${formatDate(createdAt.toISOString())}).`,
    { exact: false },
  );
});

test('§7.6: within seven days the same user signs in and the unsent row is kept', async () => {
  await loseSessionWithOneUnsent();
  mount();
  await signInThroughTheScreen();
  await waitFor(async () => expect(await listUnfinished()).toHaveLength(1));
  expect(session().discardedNotice).toBeNull();
});

test('§7.6: before the queue resumes, a re-login past seven days discards first', async () => {
  await loseSessionWithOneUnsent();
  mount();
  await waitFor(() => expect(session().status).toBe('signed-out'));
  await setMeta(META.sessionLostAt, eightDaysAgo().toISOString()); // the user waited on this screen
  await signInThroughTheScreen();
  await waitFor(() => expect(session().discardedNotice).toMatch(/^1 unsent item was discarded/));
  expect(await listUnfinished()).toEqual([]);
});

test('L2: after a 401 the same user signing in again registers for push again', async () => {
  let meStatus = 200;
  installFakeApi(
    routes({
      'GET /api/v1/me': () =>
        meStatus === 200
          ? { status: 200, body: meFixture() }
          : { status: 401, body: errorBody(ErrorCode.AUTH_REQUIRED, 'Ended.') },
    }),
  );
  mount();
  await signInThroughTheScreen();
  expect(registerPush).toHaveBeenCalledTimes(1);
  meStatus = 401;
  await act(async () => {
    await session().refreshMe();
  });
  await waitFor(() => expect(session().status).toBe('signed-out'));
  meStatus = 200;
  await signInThroughTheScreen();
  expect(registerPush).toHaveBeenCalledTimes(2);
});
