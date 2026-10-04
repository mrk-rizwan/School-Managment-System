import { setBearerToken } from '../api/client';
import { queryClient } from '../api/query-client';
import type { LoginResultDto, MeDto } from '../api/contracts';
import { wipeDatabase } from '../db/database';
import { clearLog } from '../platform/log';
import { resetDatabases } from './sqlite-adapter';
import { resetSecureStore } from './secure-store';

// A fake API behind the global fetch: the real client, middlewares and timeouts run; only the
// network is replaced. Every request is recorded with its headers and body for assertions.

export const SERVER_DATE = 'Sun, 04 Oct 2026 04:32:00 GMT';

export type FakeRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  credentials: string | undefined;
  body: unknown;
  bodyText: string;
};

export type FakeReply =
  { status: number; body?: unknown; headers?: Record<string, string> } | 'network';
export type Handler = (request: FakeRequest) => FakeReply | Promise<FakeReply>;

export type FakeApi = {
  calls: FakeRequest[];
  /** Bytes of each exchange: request body, response body. */
  traffic: { path: string; requestBytes: number; responseBytes: number }[];
  routes: Record<string, Handler>;
};

export function errorBody(code: string, message: string, details: unknown = null) {
  return { error: { code, message, details, requestId: 'req-1' } };
}

export function installFakeApi(routes: Record<string, Handler>): FakeApi {
  const api: FakeApi = { calls: [], traffic: [], routes };
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const bodyText = request.method === 'GET' ? '' : await request.text();
      const call: FakeRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        credentials: init?.credentials,
        body: bodyText === '' ? null : (JSON.parse(bodyText) as unknown),
        bodyText,
      };
      api.calls.push(call);
      const handler = api.routes[`${call.method} ${call.path}`];
      const reply = handler
        ? await handler(call)
        : { status: 404, body: errorBody('NOT_FOUND', 'Not found') };
      if (reply === 'network') throw new TypeError('Network request failed');
      const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
      api.traffic.push({
        path: call.path,
        requestBytes: bodyText.length,
        responseBytes: text.length,
      });
      return new Response(reply.status === 204 || text === '' ? null : text, {
        status: reply.status,
        headers: { 'Content-Type': 'application/json', Date: SERVER_DATE, ...reply.headers },
      });
    });
  return api;
}

/** Between tests: no database, no secure store, no log, no token, no query cache. */
export async function resetDevice(): Promise<void> {
  await wipeDatabase();
  resetDatabases();
  resetSecureStore();
  clearLog();
  setBearerToken(null);
  queryClient.clear();
  jest.restoreAllMocks();
  jest.clearAllMocks();
}

export const PRINCIPAL_CNIC = '3520112345671';

export function meFixture(overrides: Partial<MeDto> = {}): MeDto {
  return {
    id: '41',
    fullName: 'Ayesha Khan',
    email: 'ayesha@example.com',
    hasVerifiedEmail: true,
    passwordIsDefault: false,
    school: { id: '7', name: 'Demo School', shortCode: 'demo', status: 'active' },
    roles: ['principal'],
    capabilities: ['attendance.student.view_all', 'announcement.send.school'],
    sessionExpiresAt: '2027-01-02T00:00:00.000Z',
    capacities: ['staff'],
    assignments: [],
    children: [],
    staffId: '5',
    ...overrides,
  };
}

export function loginFixture(
  token = 'T'.repeat(43),
  overrides: Partial<MeDto> = {},
): LoginResultDto {
  return { ...meFixture(overrides), bearerToken: token };
}
