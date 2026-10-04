import { setBearerToken } from '../api/client';
import { queryClient } from '../api/query-client';
import type { LoginResultDto, MeDto } from '../api/contracts';
import { wipeDatabase } from '../db/database';
import { clearLog } from '../platform/log';
import { resetFileSystem } from './file-system';
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
  | {
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
      /** Answer as a server that ignores `Prefer: return=minimal` (the full shape, no header). */
      ignorePrefer?: boolean;
    }
  | 'network';
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

/** A JSON body parsed; anything else (a multipart upload) is kept as text only. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const STATUSES = ['present', 'absent', 'late', 'on_leave'];
const MARK_KEYS = new Set(['enrolmentId', 'status', 'note', 'arrivedAt']);
const BODY_KEYS = new Set(['date', 'period', 'marks', 'reason']);

/**
 * SubmitRegisterDto as the server's ValidationPipe checks it (whitelist, forbidNonWhitelisted;
 * `@IfPresent() reason` 3–500 — so `reason: null` is a 422, wave-F review): the field at fault,
 * or null when the body would be accepted.
 */
export function submitRegisterProblem(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'body';
  const b = body as Record<string, unknown>;
  for (const key of Object.keys(b)) if (!BODY_KEYS.has(key)) return key;
  if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return 'date';
  if (typeof b.period !== 'number' || !Number.isInteger(b.period) || b.period < 1) return 'period';
  if ('reason' in b) {
    if (typeof b.reason !== 'string') return 'reason';
    const length = b.reason.trim().length;
    if (length < 3 || length > 500) return 'reason';
  }
  if (!Array.isArray(b.marks) || b.marks.length === 0) return 'marks';
  for (const [i, raw] of (b.marks as unknown[]).entries()) {
    if (typeof raw !== 'object' || raw === null) return `marks[${i}]`;
    const mark = raw as Record<string, unknown>;
    for (const key of Object.keys(mark)) if (!MARK_KEYS.has(key)) return `marks[${i}].${key}`;
    if (typeof mark.enrolmentId !== 'string' || !/^[1-9]\d*$/.test(mark.enrolmentId)) {
      return `marks[${i}].enrolmentId`;
    }
    if (typeof mark.status !== 'string' || !STATUSES.includes(mark.status)) {
      return `marks[${i}].status`;
    }
    if ('note' in mark && (typeof mark.note !== 'string' || mark.note.length > 200)) {
      return `marks[${i}].note`;
    }
    if (
      'arrivedAt' in mark &&
      (mark.status !== 'late' ||
        typeof mark.arrivedAt !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(mark.arrivedAt))
    ) {
      return `marks[${i}].arrivedAt`;
    }
  }
  return null;
}

const SUBMIT_REGISTER = /^\/api\/v1\/sections\/[^/]+\/submit-register$/;

/**
 * The submit's answer as the API gives it (slice-16 R160): with `Prefer: return=minimal` each
 * mark is `{ id, enrolmentId, outcome }` and `Preference-Applied: return=minimal` says so. A
 * handler may answer in the full shape; it is reduced here unless `ignorePrefer` is set.
 */
function minimalWhenPreferred(
  call: FakeRequest,
  reply: Exclude<FakeReply, 'network'>,
): Exclude<FakeReply, 'network'> {
  const prefers = /\breturn=minimal\b/.test(call.headers.get('Prefer') ?? '');
  if (!prefers || reply.ignorePrefer || reply.status < 200 || reply.status > 299) return reply;
  const body = reply.body as { marks?: Record<string, unknown>[] } | undefined;
  const marks = body?.marks?.map((m) => ({ id: m.id, enrolmentId: m.enrolmentId, outcome: m.outcome }));
  return {
    ...reply,
    body: body === undefined ? body : { ...body, ...(marks ? { marks } : {}) },
    headers: { ...reply.headers, 'Preference-Applied': 'return=minimal' },
  };
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
        body: bodyText === '' ? null : parsed(bodyText),
        bodyText,
      };
      api.calls.push(call);
      const handler = api.routes[`${call.method} ${call.path}`];
      const problem =
        handler && call.method === 'POST' && SUBMIT_REGISTER.test(call.path)
          ? submitRegisterProblem(call.body)
          : null;
      const reply: FakeReply =
        problem !== null
          ? {
              status: 422,
              body: errorBody('VALIDATION_FAILED', 'Invalid', {
                fields: [{ path: problem, code: 'INVALID_VALUE', message: `${problem} is invalid` }],
              }),
            }
          : handler
            ? await handler(call)
            : { status: 404, body: errorBody('NOT_FOUND', 'Not found') };
      if (reply === 'network') throw new TypeError('Network request failed');
      const answer = SUBMIT_REGISTER.test(call.path) ? minimalWhenPreferred(call, reply) : reply;
      const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
      api.traffic.push({
        path: call.path,
        requestBytes: bodyText.length,
        responseBytes: text.length,
      });
      return new Response(answer.status === 204 || text === '' ? null : text, {
        status: answer.status,
        headers: { 'Content-Type': 'application/json', Date: SERVER_DATE, ...answer.headers },
      });
    });
  return api;
}

/** Between tests: no database, no secure store, no log, no token, no query cache. */
export async function resetDevice(): Promise<void> {
  await wipeDatabase();
  resetDatabases();
  resetSecureStore();
  resetFileSystem();
  clearLog();
  setBearerToken(null);
  queryClient.clear();
  // No garbage-collection timers: a 24-hour gcTime timer would keep Jest alive after a screen test.
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: { ...defaults.queries, gcTime: Number.POSITIVE_INFINITY },
  });
  jest.restoreAllMocks();
  jest.clearAllMocks();
}

export const PRINCIPAL_CNIC = '3520112345671';

export function meFixture(overrides: Partial<MeDto> = {}): MeDto {
  const capabilities =
    overrides.capabilities ??
    (['attendance.student.view_all', 'announcement.send.school'] as MeDto['capabilities']);
  // As the server reports it (slice-14 §8): a teacher's defaults are scoped to their assignments,
  // every other source is school-wide.
  const scope = overrides.roles?.length === 1 && overrides.roles[0] === 'teacher'
    ? ('assigned_sections' as const)
    : ('all' as const);
  return {
    id: '41',
    fullName: 'Ayesha Khan',
    email: 'ayesha@example.com',
    hasVerifiedEmail: true,
    passwordIsDefault: false,
    school: { id: '7', name: 'Demo School', shortCode: 'demo', status: 'active' },
    roles: ['principal'],
    capabilities,
    capabilityScopes: capabilities.map((capability) => ({ capability, scope })),
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
