import { Capability, SYSTEM_ROLE_DEFAULTS } from '@asms/shared';
import { expect, type Page, type Request } from '@playwright/test';
import type { ApiErrorEnvelope } from '../../lib/api/errors';
import type { AcademicYearDto, ClassDto, SectionDto, SubjectDto } from '../../lib/api/school-academics-contract';
import type { CapabilityScope } from '../../lib/api/school-announcements-contract';
import type { MeDto } from '../../lib/api/school-contract';

// Fixtures and the mocked API shared by the wave-E specs (attendance, staff attendance, diary
// and remarks). Every /api/v1/* request is answered in the browser; anything unanswered is a
// 500 and is recorded, so no screen is checked in an error state by accident.

export const STAMP = '2026-09-20T05:00:00.000Z';
/** Tuesday 6 October 2026, 10:00 in Karachi. */
export const NOW = new Date('2026-10-06T05:00:00Z');
export const TODAY = '2026-10-06';

type Assignment = MeDto['assignments'][number];
export const assignment = (extra: Partial<Assignment>): Assignment => ({
  id: 'ta1',
  academicYearId: 'y1',
  attendanceMode: 'daily',
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  role: 'class_teacher',
  startsOn: '2026-04-01',
  endsOn: null,
  subjectId: null,
  subjectName: null,
  ...extra,
});

/** GET /me `capabilityScopes` (contracts/slice-14.md §8): one entry per capability, in order. */
export const scopesOf = (capabilities: readonly Capability[], scope: CapabilityScope, overrides: Partial<Record<Capability, CapabilityScope>> = {}) =>
  capabilities.map((capability) => ({ capability, scope: overrides[capability] ?? scope }));

const ALL_CAPABILITIES = Object.values(Capability).sort();
const OFFICE_CAPABILITIES = [...SYSTEM_ROLE_DEFAULTS.office_staff].sort();
const TEACHER_CAPABILITIES = [...SYSTEM_ROLE_DEFAULTS.teacher].sort();

export const PRINCIPAL_ME: MeDto = {
  id: 'u-principal',
  staffId: 'st-p',
  fullName: 'Amina Principal',
  email: 'amina@example.test',
  hasVerifiedEmail: true,
  passwordIsDefault: false,
  blockedCapabilities: [],
  school: { id: 's1', name: 'Green Valley School', shortCode: 'greenvalley', status: 'active' },
  roles: ['principal'],
  capabilities: ALL_CAPABILITIES,
  capabilityScopes: scopesOf(ALL_CAPABILITIES, 'all'),
  sessionExpiresAt: '2026-11-02T05:00:00.000Z',
  capacities: ['staff'],
  assignments: [],
  children: [],
};
export const OFFICE_ME: MeDto = {
  ...PRINCIPAL_ME,
  id: 'u-office',
  staffId: 'st-o',
  fullName: 'Bilal Office',
  roles: ['office_staff'],
  capabilities: OFFICE_CAPABILITIES,
  capabilityScopes: scopesOf(OFFICE_CAPABILITIES, 'all'),
};
export const TEACHER_ME: MeDto = {
  ...PRINCIPAL_ME,
  id: 'u-teacher',
  staffId: 'st-t',
  fullName: 'Ayesha Malik',
  roles: ['teacher'],
  capabilities: TEACHER_CAPABILITIES,
  capabilityScopes: scopesOf(TEACHER_CAPABILITIES, 'assigned_sections'),
  assignments: [assignment({})],
};

export const YEARS: AcademicYearDto[] = [
  { id: 'y1', name: '2026-27', startsOn: '2026-04-01', endsOn: '2027-03-31', status: 'active', createdAt: STAMP, updatedAt: STAMP },
];
export const CLASSES: ClassDto[] = [
  {
    id: 'c5',
    academicYearId: 'y1',
    academicYearName: '2026-27',
    name: 'Class 5',
    attendanceMode: 'daily',
    sortOrder: 5,
    status: 'active',
    nextClassId: null,
    nextClassName: null,
    isFinal: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  },
];
export const SECTIONS: SectionDto[] = [
  { id: 'sec-a', classId: 'c5', name: 'A', capacity: 40, archivedAt: null, createdAt: STAMP, updatedAt: STAMP },
  { id: 'sec-b', classId: 'c5', name: 'B', capacity: 40, archivedAt: null, createdAt: STAMP, updatedAt: STAMP },
];
const subject = (id: string, name: string): SubjectDto => ({ id, name, code: null, archivedAt: null, createdAt: STAMP, updatedAt: STAMP });
export const SUBJECTS = [subject('sub-m', 'Mathematics'), subject('sub-e', 'English'), subject('sub-u', 'Urdu')];

export const page1 = <T>(data: T[]) => ({ data, page: 1, limit: 25, total: data.length });

type ErrorBody = ApiErrorEnvelope['error'];
export const errorBody = (code: ErrorBody['code'], message: string, details: ErrorBody['details'] = null) => ({
  error: { code, message, details, requestId: 'req-test' },
});

export type Reply = { status: number; body: unknown };
export type Call = { method: string; path: string; url: URL; request: Request };
/** A screen's own routes: return a reply, or undefined to fall through to the common ones. */
export type Handler = (call: Call) => Reply | undefined;

/**
 * Answers every /api/v1 request: canned replies first (`'POST /path'`, an array is used up in
 * order), then the spec's handler, then GET /me, the academic structure and the calendar.
 */
export async function mockSchoolApi(
  page: Page,
  { me, handler, replies = {} }: { me: MeDto; handler?: Handler; replies?: Record<string, Reply | Reply[]> },
) {
  const requests: Request[] = [];
  const unmocked: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    requests.push(request);
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const json = (reply: Reply) =>
      route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });

    const canned = replies[`${method} ${path}`];
    if (canned) {
      const reply = Array.isArray(canned) ? canned.shift() : canned;
      if (reply) return json(reply);
    }
    const handled = handler?.({ method, path, url, request });
    if (handled) return json(handled);
    if (method === 'GET') {
      if (path === '/me') return json({ status: 200, body: me });
      if (path === '/academic-years') return json({ status: 200, body: page1(YEARS) });
      if (path === '/classes') return json({ status: 200, body: page1(CLASSES) });
      if (path === '/classes/c5') return json({ status: 200, body: CLASSES[0] });
      if (path === '/classes/c5/sections') return json({ status: 200, body: page1(SECTIONS) });
      if (path === '/sections/sec-a') return json({ status: 200, body: SECTIONS[0] });
      if (path === '/subjects') return json({ status: 200, body: page1(SUBJECTS) });
      if (path === '/calendar/teaching-days') {
        return json({
          status: 200,
          body: {
            dateFrom: url.searchParams.get('dateFrom'),
            dateTo: url.searchParams.get('dateTo'),
            teachingDays: 1,
            weeklyOffDays: [0],
            holidays: [],
          },
        });
      }
    }
    unmocked.push(`${method} ${path}`);
    return json({ status: 500, body: errorBody('INTERNAL_ERROR', `Unmocked ${method} ${path}`) });
  });
  return { requests, unmocked };
}

/** Fixes the clock (so "today" is TODAY) and opens the path. */
export async function open(page: Page, path: string) {
  await page.clock.setFixedTime(NOW);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

export const calls = (requests: Request[], method: string, path: string) =>
  requests.filter((r) => r.method() === method && new URL(r.url()).pathname === `/api/v1${path}`);

/** Plan §9: at tablet width the page itself never scrolls sideways (a wide table scrolls inside). */
export async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

export const TABLET = { width: 768, height: 1024 };
