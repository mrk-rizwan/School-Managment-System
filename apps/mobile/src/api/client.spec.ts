import { ErrorCode, toApiError } from '@asms/shared';
import createClient from 'openapi-fetch';
import {
  errorBody,
  installFakeApi,
  loginFixture,
  meFixture,
  resetDevice,
  SERVER_DATE,
} from '../test/fake-api';
import { DOCUMENT, File, putFile } from '../test/file-system';
import { sendItem } from '../outbox/runtime';
import * as lanes from '../outbox/lanes';
import type { OutboxItem } from '../outbox/machine';
import {
  api,
  authHeaders,
  isNetworkError,
  onSessionLost,
  onUpgradeRequired,
  READ_TIMEOUT_MS,
  sendMultipart,
  sendRaw,
  setBearerToken,
  timedFetch,
  unwrap,
  unwrapWithDate,
} from './client';
import type { paths } from './school';

// slice-15 §2.5, §6: every request's headers, and the 401 and 426 routing.

beforeEach(resetDevice);

const token = 'A'.repeat(43);

describe("the device's fetch: expo/fetch answers with a FetchResponse, not instanceof Response", () => {
  const loginBody = {
    schoolCode: 'demo',
    username: '3520112345671',
    password: 'x', // pragma: allowlist secret
    channel: 'bearer' as const,
  };

  test('login and a cached read resolve through the typed client, with the Date header', async () => {
    installFakeApi({
      'POST /api/v1/auth/login': () => ({ status: 200, body: loginFixture('L'.repeat(43)) }),
      'GET /api/v1/me': () => ({ status: 200, body: meFixture() }),
    });
    const login = await api.POST('/api/v1/auth/login', { body: loginBody });
    expect(login.response instanceof Response).toBe(false);
    expect(login.data?.bearerToken).toBe('L'.repeat(43));
    setBearerToken(token);
    const { data, date } = await unwrapWithDate(api.GET('/api/v1/me'));
    expect(data.fullName).toBe('Ayesha Khan');
    expect(date).toBe(SERVER_DATE);
  });

  test('the 401 inspection (a clone of the body) still routes, and the caller still reads it', async () => {
    installFakeApi({
      'GET /api/v1/me': () => ({ status: 401, body: errorBody(ErrorCode.AUTH_REQUIRED, 'Gone.') }),
    });
    const lost = jest.fn();
    const off = onSessionLost(lost);
    setBearerToken(token);
    await expect(unwrap(api.GET('/api/v1/me'))).rejects.toMatchObject({
      status: 401,
      code: ErrorCode.AUTH_REQUIRED,
    });
    expect(lost).toHaveBeenCalledTimes(1);
    off();
  });

  test('the harness catches the defect: a middleware returning the response fails as on a device', async () => {
    installFakeApi({ 'GET /api/v1/me': () => ({ status: 200, body: meFixture() }) });
    const broken = createClient<paths>({ baseUrl: 'http://api.test', fetch: timedFetch });
    broken.use({ onResponse: ({ response }) => response });
    await expect(broken.GET('/api/v1/me')).rejects.toThrow(/onResponse: must return new Response/);
  });
});

describe('isNetworkError: only a request that got no answer', () => {
  test.each([
    ['expo/fetch FetchError', new Error('fetch failed: java.net.UnknownHostException'), true],
    ['expo/fetch abort', new Error('fetch failed: The operation was aborted.'), true],
    ["React Native's fetch", new TypeError('Network request failed'), true],
    ["React Native's timeout", new TypeError('Network request timed out'), true],
    ["Node's fetch", new TypeError('fetch failed'), true],
    ['an AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' }), true],
    ['an ApiError', toApiError({ status: 503, headers: new Headers() }, null), false],
    ['a refused body', new TypeError('Unsupported BodyInit type'), false],
    ['a refused part', new Error('Unsupported FormDataPart implementation'), false],
    ['a bug', new TypeError("Cannot read properties of undefined (reading 'id')"), false],
    ['openapi-fetch', new Error('onResponse: must return new Response() when modifying'), false],
    ['not an error', 'offline', false],
  ])('%s', (_label, error, expected) => {
    expect(isNetworkError(error)).toBe(expected);
  });
});

describe('headers', () => {
  test('every request carries X-App-Version and Accept; no bearer when signed out; never Origin or a cookie', async () => {
    const fake = installFakeApi({ 'GET /api/v1/me': () => ({ status: 200, body: meFixture() }) });
    await unwrap(api.GET('/api/v1/me'));
    const [call] = fake.calls;
    expect(call!.headers.get('X-App-Version')).toBe('0.1.0');
    expect(call!.headers.get('Accept')).toBe('application/json');
    expect(call!.headers.has('Authorization')).toBe(false);
    expect(call!.headers.has('Origin')).toBe(false);
    expect(call!.headers.has('Cookie')).toBe(false);
    expect(call!.credentials).toBe('omit');
  });

  test('the bearer token when signed in, on typed and raw requests alike', async () => {
    const fake = installFakeApi({
      'GET /api/v1/me': () => ({ status: 200, body: meFixture() }),
      'POST /api/v1/me/devices': () => ({ status: 201, body: {} }),
    });
    setBearerToken(token);
    await unwrap(api.GET('/api/v1/me'));
    await sendRaw('POST', '/api/v1/me/devices', '{"platform":"android","pushToken":"x"}');
    for (const call of fake.calls) {
      expect(call.headers.get('Authorization')).toBe(`Bearer ${token}`);
      expect(call.headers.get('X-App-Version')).toBe('0.1.0');
      expect(call.headers.has('Origin')).toBe(false);
      expect(call.credentials).toBe('omit');
    }
  });

  test('Idempotency-Key equals the outbox id on header lanes, and is absent otherwise', async () => {
    const fake = installFakeApi({
      'POST /api/v1/sections/12/diary-entries': () => ({ status: 201, body: {} }),
      'POST /api/v1/me/devices': () => ({ status: 201, body: {} }),
    });
    const base: OutboxItem = {
      id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      lane: 'device_register',
      method: 'POST',
      path: '/api/v1/me/devices',
      naturalKey: null,
      body: '{}',
      state: 'sending',
      attempts: 1,
      nextAttemptAt: null,
      sendingSince: null,
      responseStatus: null,
      responseCode: null,
      responseMessage: null,
      responseDetails: null,
      domainTable: null,
      domainId: null,
      createdAt: '',
      updatedAt: '',
    };
    await sendItem(base);
    expect(fake.calls[0]!.headers.has('Idempotency-Key')).toBe(false);

    // A header lane (slice 16's diary_entry).
    expect(lanes.laneOf('diary_entry')?.idempotencyHeader).toBe(true);
    await sendItem({ ...base, lane: 'diary_entry', path: '/api/v1/sections/12/diary-entries' });
    expect(fake.calls[1]!.headers.get('Idempotency-Key')).toBe(base.id);
  });
});

describe('routing of 401 and 426', () => {
  test('a 401 to a bearer request fires session-lost once', async () => {
    installFakeApi({
      'GET /api/v1/me': () => ({
        status: 401,
        body: errorBody(ErrorCode.AUTH_REQUIRED, 'Sign in.'),
      }),
    });
    const lost = jest.fn();
    const off = onSessionLost(lost);
    setBearerToken(token);
    await expect(unwrap(api.GET('/api/v1/me'))).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
    off();
  });

  test('no session-lost for AUTH_FAILED at login, for logout, or for a request without a token', async () => {
    installFakeApi({
      'POST /api/v1/auth/login': () => ({
        status: 401,
        body: errorBody(ErrorCode.AUTH_FAILED, 'Wrong.'),
      }),
      'POST /api/v1/auth/logout': () => ({
        status: 401,
        body: errorBody(ErrorCode.AUTH_REQUIRED, 'Gone.'),
      }),
      'GET /api/v1/me': () => ({
        status: 401,
        body: errorBody(ErrorCode.AUTH_REQUIRED, 'Sign in.'),
      }),
    });
    const lost = jest.fn();
    const off = onSessionLost(lost);
    setBearerToken(token);
    await api.POST('/api/v1/auth/login', {
      body: { schoolCode: 'demo', username: '3520112345671', password: 'x', channel: 'bearer' },
    });
    await api.POST('/api/v1/auth/logout');
    setBearerToken(null);
    await api.GET('/api/v1/me');
    expect(lost).not.toHaveBeenCalled();
    off();
  });

  test('a 401 to a replaced token does not fire session-lost (review L1)', async () => {
    const fake = installFakeApi({
      'GET /api/v1/me': () => {
        // change-password replaced the token while this request was on the wire
        setBearerToken('B'.repeat(43));
        return { status: 401, body: errorBody(ErrorCode.AUTH_REQUIRED, 'Sign in.') };
      },
    });
    const lost = jest.fn();
    const off = onSessionLost(lost);
    setBearerToken(token);
    await api.GET('/api/v1/me');
    expect(fake.calls[0]!.headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(lost).not.toHaveBeenCalled();
    off();
  });

  test('an outbox send whose token was replaced in flight returns stale_token, not a pause', async () => {
    installFakeApi({
      'POST /api/v1/me/devices': () => {
        setBearerToken('B'.repeat(43)); // replaced while the request was on the wire
        return { status: 401, body: errorBody(ErrorCode.AUTH_REQUIRED, 'Sign in.') };
      },
    });
    const lost = jest.fn();
    const off = onSessionLost(lost);
    setBearerToken(token);
    const item = {
      id: 'i1',
      lane: 'device_register',
      method: 'POST',
      path: '/api/v1/me/devices',
      body: '{}',
    } as OutboxItem;
    expect(await sendItem(item)).toEqual({ kind: 'stale_token' });
    expect(lost).not.toHaveBeenCalled();
    off();
  });

  test('an outbox 401 to the current token is a real loss', async () => {
    installFakeApi({
      'POST /api/v1/me/devices': () => ({
        status: 401,
        body: errorBody(ErrorCode.AUTH_REQUIRED, 'Sign in.'),
      }),
    });
    const lost = jest.fn();
    const off = onSessionLost(lost);
    setBearerToken(token);
    const item = {
      id: 'i1',
      lane: 'device_register',
      method: 'POST',
      path: '/api/v1/me/devices',
      body: '{}',
    } as OutboxItem;
    expect(await sendItem(item)).toMatchObject({ kind: 'response', status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
    off();
  });

  test('a 426 fires upgrade-required with the minimum version, login included', async () => {
    installFakeApi({
      'POST /api/v1/auth/login': () => ({
        status: 426,
        body: errorBody(ErrorCode.UPGRADE_REQUIRED, 'Update the app to continue.', {
          minimumVersion: '99.0.0',
        }),
      }),
    });
    const upgrade = jest.fn();
    const off = onUpgradeRequired(upgrade);
    await api.POST('/api/v1/auth/login', {
      body: { schoolCode: 'demo', username: '3520112345671', password: 'x', channel: 'bearer' },
    });
    expect(upgrade).toHaveBeenCalledWith({
      minimumVersion: '99.0.0',
      message: 'Update the app to continue.',
    });
    off();
  });
});

describe('timeouts', () => {
  test('a read that never answers is aborted after 20 s and surfaces as a network error', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(globalThis, 'fetch').mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      const pending = unwrap(api.GET('/api/v1/me'));
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await jest.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('slice-16 §11: multipart and the headers for requests the client does not make', () => {
  test('a multipart upload carries the bearer and X-App-Version, no JSON type, no Origin, no cookie', async () => {
    const fake = installFakeApi({
      'POST /api/v1/uploads': () => ({ status: 201, body: { id: 'u1' } }),
    });
    setBearerToken(token);
    putFile(`${DOCUMENT}outbox/p1.jpg`, 1234);
    const response = await sendMultipart('/api/v1/uploads', 'file', new File(`${DOCUMENT}outbox/p1.jpg`));
    expect(response.status).toBe(201);
    const [call] = fake.calls;
    expect(call!.method).toBe('POST');
    // The file part as expo/fetch builds it from the File: its name, the type of its extension,
    // its bytes.
    expect(call!.parts).toEqual([
      { field: 'file', filename: 'p1.jpg', type: 'image/jpeg', size: 1234 },
    ]);
    expect(call!.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(call!.headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(call!.headers.get('X-App-Version')).toBe('0.1.0');
    expect(call!.headers.get('Content-Type') ?? '').not.toContain('application/json');
    expect(call!.headers.has('Origin')).toBe(false);
    expect(call!.headers.has('Cookie')).toBe(false);
    expect(call!.credentials).toBe('omit');
  });

  test("React Native's { uri, name, type } part is refused as expo/fetch refuses it, before any request", async () => {
    const fake = installFakeApi({
      'POST /api/v1/uploads': () => ({ status: 201, body: { id: 'u1' } }),
    });
    const rnPart = { uri: 'file:///x/p1.jpg', name: 'p1.jpg', type: 'image/jpeg' };
    const error: unknown = await sendMultipart(
      '/api/v1/uploads',
      'file',
      rnPart as unknown as Blob,
    ).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ message: 'Unsupported FormDataPart implementation' });
    // Not "offline": the outbox must not retry it forever.
    expect(isNetworkError(error)).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test('authHeaders: the bearer only when signed in, never in a URL', () => {
    expect(authHeaders()).toEqual({ 'X-App-Version': '0.1.0', Accept: 'image/*' });
    setBearerToken(token);
    expect(authHeaders('application/pdf')).toEqual({
      'X-App-Version': '0.1.0',
      Accept: 'application/pdf',
      Authorization: `Bearer ${token}`,
    });
    setBearerToken(null);
    expect(authHeaders()).not.toHaveProperty('Authorization');
  });

  test('no file outside client.ts writes a Bearer header itself', () => {
    const { readdirSync, readFileSync, statSync } =
      jest.requireActual<typeof import('node:fs')>('node:fs');
    const { join, relative } = jest.requireActual<typeof import('node:path')>('node:path');
    const root = join(__dirname, '..');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const offenders = files(root)
      .filter((f) => /\.tsx?$/.test(f) && !/\.spec\.tsx?$/.test(f) && !/[\/]test[\/]/.test(f))
      .filter((f) => !f.endsWith(join('api', 'client.ts')))
      .filter((f) => /['"`]Bearer/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
});
