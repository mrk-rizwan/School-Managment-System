// The academic structure over HTTP (contracts/slice-3.md): the real AppModule, the real access
// guard and session resolution, the real database. Sessions are written by
// test/support/school-session.ts; behaviour in depth is in academics.spec.ts.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolSession,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { tag } from './support';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;
const ID = /^[1-9][0-9]{0,18}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface ErrorBody {
  error: {
    code: string;
    details: {
      field?: string;
      from?: string;
      to?: string;
      fields?: { path: string; code: string }[];
    };
  };
}
type Body = Record<string, unknown>;

describe('academic structure (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const http = () => request(app.getHttpServer());

  /** A signed-in staff member of `school` (a new active school unless given). */
  const signIn = async (
    systemRole: 'principal' | 'office_staff' | 'teacher' = 'principal',
    school?: TestSchool,
  ): Promise<TestSchoolSession & { school: TestSchool }> => {
    const owner = school ?? (await createSchool());
    const user = await createSchoolUser(testDb(), owner, { systemRole });
    return { ...(await createSchoolSession(testDb(), owner, user)), school: owner };
  };

  const get = (path: string, s: { cookie: string }) =>
    http().get(`${API}${path}`).set('Cookie', s.cookie);
  const post = (path: string, body: object, s: { cookie: string }) =>
    http().post(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);
  const patch = (path: string, body: object, s: { cookie: string }) =>
    http().patch(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);

  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;
  const fieldsOf = (res: { body: unknown }) =>
    (errorOf(res).details.fields ?? []).map((f) => `${f.path}:${f.code}`);

  const newYear = async (s: { cookie: string }, body: Body = {}): Promise<Body> => {
    const res = await post(
      '/academic-years',
      { name: `Y ${tag()}`, startsOn: '2026-04-01', endsOn: '2027-03-31', ...body },
      s,
    );
    expect(res.status).toBe(201);
    return res.body as Body;
  };
  const newClass = async (s: { cookie: string }, body: Body = {}): Promise<Body> => {
    const academicYearId = body.academicYearId ?? (await newYear(s)).id;
    const res = await post(
      '/classes',
      { name: `C ${tag()}`, attendanceMode: 'daily', ...body, academicYearId },
      s,
    );
    expect(res.status).toBe(201);
    return res.body as Body;
  };

  describe('access', () => {
    it('refuses every route without a session (401)', async () => {
      for (const path of [
        '/academic-years',
        '/classes',
        '/subjects',
        '/sections/1',
        '/classes/1/sections',
      ]) {
        const res = await http().get(`${API}${path}`);
        expect([path, res.status, errorOf(res).code]).toEqual([path, 401, 'AUTH_REQUIRED']);
      }
    });

    it('lets any staff role read, and only holders of the capability write', async () => {
      const principal = await signIn('principal');
      const year = await newYear(principal);
      for (const role of ['teacher', 'office_staff'] as const) {
        const staff = await signIn(role, principal.school);
        expect((await get('/academic-years', staff)).status).toBe(200);
        expect((await get(`/academic-years/${String(year.id)}`, staff)).status).toBe(200);
        const writes = [
          post(
            '/academic-years',
            { name: 'X1', startsOn: '2026-01-01', endsOn: '2026-12-31' },
            staff,
          ),
          post(`/academic-years/${String(year.id)}/activate`, {}, staff),
          post('/classes', { academicYearId: year.id, name: 'X', attendanceMode: 'daily' }, staff),
          post('/subjects', { name: 'X' }, staff),
        ];
        for (const res of await Promise.all(writes)) {
          expect([res.status, errorOf(res).code]).toEqual([403, 'PERMISSION_DENIED']);
        }
      }
    });

    it('a suspended school can read but not write (403 SCHOOL_SUSPENDED)', async () => {
      const school = await createSchool({ status: 'suspended' });
      const principal = await signIn('principal', school);
      expect((await get('/subjects', principal)).status).toBe(200);
      const res = await post('/subjects', { name: 'Science' }, principal);
      expect([res.status, errorOf(res).code]).toEqual([403, 'SCHOOL_SUSPENDED']);
    });

    it('refuses a cookie write from another origin (403 ORIGIN_REJECTED)', async () => {
      const principal = await signIn();
      const res = await http()
        .post(`${API}/subjects`)
        .set('Cookie', principal.cookie)
        .set('Origin', 'https://evil.example')
        .send({ name: 'Science' });
      expect([res.status, errorOf(res).code]).toEqual([403, 'ORIGIN_REJECTED']);
    });

    it('404s another school’s rows, identically to a missing or malformed id', async () => {
      const owner = await signIn();
      const year = await newYear(owner);
      const klass = await newClass(owner);
      const section = (await post(`/classes/${String(klass.id)}/sections`, { name: 'A' }, owner))
        .body as Body;
      const subject = (await post('/subjects', { name: 'Art' }, owner)).body as Body;
      const intruder = await signIn();
      const reads = [
        `/academic-years/${String(year.id)}`,
        `/classes/${String(klass.id)}`,
        `/classes/${String(klass.id)}/sections`,
        `/sections/${String(section.id)}`,
        `/subjects/${String(subject.id)}`,
        '/subjects/999999999999',
        '/subjects/abc',
        '/subjects/0',
      ];
      for (const path of reads) {
        const res = await get(path, intruder);
        expect([path, res.status, errorOf(res).code]).toEqual([path, 404, 'NOT_FOUND']);
      }
      const writes = [
        patch(`/academic-years/${String(year.id)}`, { name: 'Mine' }, intruder),
        post(`/academic-years/${String(year.id)}/close`, {}, intruder),
        patch(`/classes/${String(klass.id)}`, { name: 'Mine' }, intruder),
        post(`/classes/${String(klass.id)}/sections`, { name: 'Z' }, intruder),
        post(`/sections/${String(section.id)}/archive`, {}, intruder),
        patch(`/subjects/${String(subject.id)}`, { name: 'Mine' }, intruder),
      ];
      for (const res of await Promise.all(writes)) expect(res.status).toBe(404);
      // Unknown ids in the intruder's own lists are empty pages, not errors.
      const list = await get(`/classes?academicYearId=${String(year.id)}`, intruder);
      expect(list.body).toMatchObject({ data: [], total: 0 });
    });
  });

  describe('academic years', () => {
    it('creates (201), normalises the name, and activates and closes (200)', async () => {
      const s = await signIn();
      const name = `  ${tag()}   2026 `;
      const res = await post(
        '/academic-years',
        { name, startsOn: '2026-04-01', endsOn: '2027-03-31' },
        s,
      );
      expect(res.status).toBe(201);
      const year = res.body as Body;
      expect(year).toEqual({
        id: expect.stringMatching(ID),
        name: name.trim().replace(/\s+/g, ' '),
        startsOn: '2026-04-01',
        endsOn: '2027-03-31',
        status: 'planned',
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
      const activated = await post(`/academic-years/${String(year.id)}/activate`, {}, s);
      expect([activated.status, (activated.body as Body).status]).toEqual([200, 'active']);
      const closed = await post(`/academic-years/${String(year.id)}/close`, {}, s);
      expect([closed.status, (closed.body as Body).status]).toEqual([200, 'closed']);
      const again = await post(`/academic-years/${String(year.id)}/activate`, {}, s);
      expect([again.status, errorOf(again).code, errorOf(again).details]).toEqual([
        409,
        'ILLEGAL_STATUS_TRANSITION',
        { from: 'closed', to: 'active' },
      ]);
      const edit = await patch(`/academic-years/${String(year.id)}`, { name: 'Late' }, s);
      expect([edit.status, errorOf(edit).code]).toEqual([409, 'ACADEMIC_YEAR_CLOSED']);
    });

    it('answers a taken name with 409 ACADEMIC_YEAR_NAME_TAKEN', async () => {
      const s = await signIn();
      await newYear(s, { name: 'Sept 2026' });
      const res = await post(
        '/academic-years',
        { name: 'Sept  2026', startsOn: '2026-09-01', endsOn: '2027-06-30' },
        s,
      );
      expect([res.status, errorOf(res).code, errorOf(res).details]).toEqual([
        409,
        'ACADEMIC_YEAR_NAME_TAKEN',
        { field: 'name' },
      ]);
    });

    it('validates shape: dates, span, control characters, null, unknown fields', async () => {
      const s = await signIn();
      const base = { name: `Y ${tag()}`, startsOn: '2026-04-01', endsOn: '2027-03-31' };
      const cases: [Body, string][] = [
        [{ ...base, startsOn: '2026-02-30' }, 'startsOn:INVALID_VALUE'],
        [{ ...base, endsOn: '31/03/2027' }, 'endsOn:INVALID_VALUE'],
        [{ ...base, endsOn: '2026-03-01' }, 'endsOn:INVALID_VALUE'],
        [{ ...base, endsOn: '2028-04-02' }, 'endsOn:INVALID_VALUE'],
        [{ ...base, name: 'A' }, 'name:INVALID_VALUE'],
        [{ ...base, name: 'Year\t2026' }, 'name:INVALID_VALUE'],
        [{ ...base, schoolId: '1' }, 'schoolId:UNKNOWN_FIELD'],
      ];
      for (const [body, field] of cases) {
        const res = await post('/academic-years', body, s);
        expect([res.status, fieldsOf(res)]).toEqual([422, expect.arrayContaining([field])]);
      }
      const year = await newYear(s);
      const res = await patch(`/academic-years/${String(year.id)}`, { name: null }, s);
      expect([res.status, [...new Set(fieldsOf(res))]]).toEqual([422, ['name:INVALID_VALUE']]);
    });

    it('lists paginated with an allowlisted sort; anything else is 422', async () => {
      const s = await signIn();
      await newYear(s, { name: 'Older', startsOn: '2025-04-01', endsOn: '2026-03-31' });
      await newYear(s, { name: 'Newer' });
      const res = await get('/academic-years', s);
      expect(res.body).toMatchObject({ page: 1, limit: 25, total: 2 });
      expect((res.body as { data: Body[] }).data.map((y) => y.name)).toEqual(['Newer', 'Older']);
      for (const query of ['sort=status', 'limit=51', 'page=0', 'status=open', 'other=1']) {
        expect((await get(`/academic-years?${query}`, s)).status).toBe(422);
      }
    });
  });

  describe('classes and sections', () => {
    it('runs the structure end to end', async () => {
      const s = await signIn();
      const year = await newYear(s, { name: `Y ${tag()}` });
      const klass = await newClass(s, { academicYearId: year.id, name: 'Class 1', sortOrder: 1 });
      expect(klass).toEqual({
        id: expect.stringMatching(ID),
        academicYearId: year.id,
        academicYearName: year.name,
        name: 'Class 1',
        sortOrder: 1,
        attendanceMode: 'daily',
        status: 'active',
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });

      const section = await post(
        `/classes/${String(klass.id)}/sections`,
        { name: 'Rose', capacity: 30 },
        s,
      );
      expect(section.status).toBe(201);
      expect(section.body).toEqual({
        id: expect.stringMatching(ID),
        classId: klass.id,
        name: 'Rose',
        capacity: 30,
        archivedAt: null,
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
      const taken = await post(`/classes/${String(klass.id)}/sections`, { name: 'Rose' }, s);
      expect([taken.status, errorOf(taken).code]).toEqual([409, 'SECTION_NAME_TAKEN']);

      // The year is fixed once the class has a section.
      const other = await newYear(s);
      const move = await patch(`/classes/${String(klass.id)}`, { academicYearId: other.id }, s);
      expect([move.status, errorOf(move).code]).toEqual([409, 'CLASS_YEAR_IMMUTABLE']);

      const next = await newClass(s, { academicYearId: other.id, name: 'Class 1' });
      const copy = await post(
        `/classes/${String(next.id)}/copy-sections`,
        { fromClassId: klass.id },
        s,
      );
      expect(copy.status).toBe(200);
      expect(copy.body).toMatchObject({
        created: [{ name: 'Rose', capacity: 30 }],
        skippedNames: [],
      });
      const repeat = await post(
        `/classes/${String(next.id)}/copy-sections`,
        { fromClassId: klass.id },
        s,
      );
      expect(repeat.body).toEqual({ created: [], skippedNames: ['Rose'] });

      const sectionId = String((section.body as Body).id);
      const cleared = await patch(`/sections/${sectionId}`, { capacity: null }, s);
      expect([cleared.status, (cleared.body as Body).capacity]).toEqual([200, null]);
      const archived = await post(`/sections/${sectionId}/archive`, { reason: 'Merged' }, s);
      expect(archived.status).toBe(200);
      expect((archived.body as Body).archivedAt).toEqual(expect.stringMatching(ISO));
      const frozen = await patch(`/sections/${sectionId}`, { name: 'Lily' }, s);
      expect([frozen.status, errorOf(frozen).code]).toEqual([409, 'SECTION_ARCHIVED']);

      const live = await get(`/classes/${String(klass.id)}/sections`, s);
      expect(live.body).toMatchObject({ total: 0 });
      const all = await get(`/classes/${String(klass.id)}/sections?includeArchived=true`, s);
      expect(all.body).toMatchObject({ total: 1 });
      expect(
        (await get(`/classes/${String(klass.id)}/sections?includeArchived=yes`, s)).status,
      ).toBe(422);

      const archiveClass = await post(`/classes/${String(klass.id)}/archive`, {}, s);
      expect([archiveClass.status, (archiveClass.body as Body).status]).toEqual([200, 'archived']);
      const edit = await patch(`/classes/${String(klass.id)}`, { name: 'X' }, s);
      expect([edit.status, errorOf(edit).code]).toEqual([409, 'CLASS_ARCHIVED']);

      const list = await get(`/classes?academicYearId=${String(other.id)}&sort=-name`, s);
      expect(list.body).toMatchObject({ total: 1, data: [{ id: next.id }] });
    });

    it('validates class and copy bodies', async () => {
      const s = await signIn();
      const klass = await newClass(s);
      const cases: [string, Body, string][] = [
        [
          '/classes',
          { academicYearId: klass.academicYearId, name: 'X' },
          'attendanceMode:INVALID_VALUE',
        ],
        [
          '/classes',
          { academicYearId: 'abc', name: 'X', attendanceMode: 'daily' },
          'academicYearId:INVALID_VALUE',
        ],
        [
          '/classes',
          { academicYearId: '999999999999', name: 'X', attendanceMode: 'daily' },
          'academicYearId:REFERENCE_NOT_FOUND',
        ],
        [
          '/classes',
          {
            academicYearId: klass.academicYearId,
            name: 'X',
            attendanceMode: 'daily',
            sortOrder: 1000,
          },
          'sortOrder:INVALID_VALUE',
        ],
        [
          `/classes/${String(klass.id)}/copy-sections`,
          { fromClassId: klass.id },
          'fromClassId:INVALID_VALUE',
        ],
        [
          `/classes/${String(klass.id)}/copy-sections`,
          { fromClassId: '999999999999' },
          'fromClassId:REFERENCE_NOT_FOUND',
        ],
        [
          `/classes/${String(klass.id)}/sections`,
          { name: 'A', capacity: 0 },
          'capacity:INVALID_VALUE',
        ],
        [`/classes/${String(klass.id)}/archive`, { reason: 'x' }, 'reason:INVALID_VALUE'],
      ];
      for (const [path, body, field] of cases) {
        const res = await post(path, body, s);
        expect([path, res.status, fieldsOf(res)]).toEqual([
          path,
          422,
          expect.arrayContaining([field]),
        ]);
      }
      for (const query of ['q=a', 'sort=status', 'academicYearId=x']) {
        expect((await get(`/classes?${query}`, s)).status).toBe(422);
      }
    });
  });

  describe('subjects', () => {
    it('creates with the code upper-cased; taken names and codes are 409', async () => {
      const s = await signIn();
      const res = await post('/subjects', { name: '  Computer   Science ', code: ' cs-1 ' }, s);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(ID),
        name: 'Computer Science',
        code: 'CS-1',
        archivedAt: null,
        createdAt: expect.stringMatching(ISO),
        updatedAt: expect.stringMatching(ISO),
      });
      const name = await post('/subjects', { name: 'Computer Science' }, s);
      expect([name.status, errorOf(name).code, errorOf(name).details]).toEqual([
        409,
        'SUBJECT_NAME_TAKEN',
        { field: 'name' },
      ]);
      const code = await post('/subjects', { name: 'Coding', code: 'CS-1' }, s);
      expect([code.status, errorOf(code).code]).toEqual([409, 'SUBJECT_CODE_TAKEN']);
      const bad = await post('/subjects', { name: 'Bad', code: 'CS 1' }, s);
      expect([bad.status, fieldsOf(bad)]).toEqual([422, ['code:INVALID_VALUE']]);

      const id = String((res.body as Body).id);
      const cleared = await patch(`/subjects/${id}`, { code: null }, s);
      expect([cleared.status, (cleared.body as Body).code]).toEqual([200, null]);
      expect((await post(`/subjects/${id}/archive`, {}, s)).status).toBe(200);
      const frozen = await patch(`/subjects/${id}`, { name: 'CS' }, s);
      expect([frozen.status, errorOf(frozen).code]).toEqual([409, 'SUBJECT_ARCHIVED']);
      expect((await get('/subjects?q=comp', s)).body).toMatchObject({ total: 0 });
      expect((await get('/subjects?q=comp&includeArchived=true', s)).body).toMatchObject({
        total: 1,
      });
    });
  });
});
