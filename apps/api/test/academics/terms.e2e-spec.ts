// Phase 4 slice 29 over HTTP (contracts/slice-29.md, phase-4-academic.md R254-R257): terms, "not
// held" classes, result settings and class subject lists, through the real AppModule, guard and
// database. The set-up-exams part of R257 arrives with the assessments table in wave N, and the
// frozen-after-approval rules (R256, TERM_IN_USE, CLASS_SUBJECTS_FROZEN, CLASS_SUBJECT_IN_USE)
// with the sheets and marks of waves N and O.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  DEFAULT_EXAM_WEIGHT,
  DEFAULT_GRADE_BANDS,
  DEFAULT_PASS_PERCENT,
  DEFAULT_TEST_WEIGHT,
  SEEDED_TERM_NAMES,
} from '@asms/shared';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser, type TestSchoolSession } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { auditFor, tag } from './support';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;

interface ErrorBody {
  error: { code: string; details: { termId?: string | null; field?: string; fields?: { path: string; code: string; message: string }[] } };
}
interface Term {
  id: string;
  academicYearId: string;
  name: string;
  sortOrder: number;
  startsOn: string;
  endsOn: string;
  weight: number;
  createdByUser: boolean;
  skippedClasses: { classId: string; className: string; reason: string }[];
}
interface Settings {
  testWeight: number;
  examWeight: number;
  passPercent: number;
  passRule: string;
  bands: { grade: string; minPercent: number }[];
  showPosition: boolean;
  withholdCardForDues: boolean;
  notifyClassTests: boolean;
  locked: boolean;
}
interface ClassSubject {
  id: string;
  subjectId: string;
  subjectName: string;
  sortOrder: number;
  examMaxMarks: number;
}
type Session = TestSchoolSession & { school: TestSchool };

describe('slice 29: terms, result settings, class subjects (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const http = () => request(app.getHttpServer());
  const signIn = async (
    systemRole: 'principal' | 'office_staff' | 'teacher' = 'principal',
    school?: TestSchool,
  ): Promise<Session> => {
    const owner = school ?? (await createSchool());
    const user = await createSchoolUser(testDb(), owner, { systemRole });
    return { ...(await createSchoolSession(testDb(), owner, user)), school: owner };
  };
  const get = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const post = (path: string, body: object, s: { cookie: string }) =>
    http().post(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);
  const patch = (path: string, body: object, s: { cookie: string }) =>
    http().patch(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN).send(body);
  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;
  const fieldsOf = (res: { body: unknown }) => (errorOf(res).details.fields ?? []).map((f) => `${f.path}:${f.code}`);

  const newYear = async (s: Session, dates = { startsOn: '2026-04-01', endsOn: '2027-03-31' }) => {
    const res = await post('/academic-years', { name: `Y ${tag()}`, ...dates }, s);
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };
  const termsOf = async (s: Session, yearId: string): Promise<Term[]> => {
    const res = await get(`/academic-years/${yearId}/terms`, s);
    expect(res.status).toBe(200);
    return (res.body as { data: Term[] }).data;
  };
  const newClass = async (s: Session, academicYearId: string) => {
    const res = await post('/classes', { academicYearId, name: `C ${tag()}`, attendanceMode: 'daily' }, s);
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };
  const newSubject = async (s: Session) => {
    const res = await post('/subjects', { name: `S ${tag()}` }, s);
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  };

  describe('R254: a year seeds its terms and settings; terms stay inside it and never overlap', () => {
    it('creating a year seeds Mid-term (first half) and Annual (the rest), 50 / 50, and the default settings', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const terms = await termsOf(s, yearId);
      expect(terms.map((t) => [t.name, t.sortOrder, t.startsOn, t.endsOn, t.weight, t.createdByUser])).toEqual([
        [SEEDED_TERM_NAMES[0], 1, '2026-04-01', '2026-09-30', 50, false],
        [SEEDED_TERM_NAMES[1], 2, '2026-10-01', '2027-03-31', 50, false],
      ]);
      const settings = await get(`/academic-years/${yearId}/result-settings`, s);
      expect(settings.status).toBe(200);
      expect(settings.body as Settings).toMatchObject({
        testWeight: DEFAULT_TEST_WEIGHT,
        examWeight: DEFAULT_EXAM_WEIGHT,
        passPercent: DEFAULT_PASS_PERCENT,
        passRule: 'all_subjects',
        bands: DEFAULT_GRADE_BANDS,
        showPosition: true,
        withholdCardForDues: false,
        notifyClassTests: false,
        locked: false,
      });
    });

    it('the backfill: a year written before Phase 4 gets its terms and settings, once, from the one seed function', async () => {
      const school = await createSchool();
      const year = await testDb().academicYear.create({
        data: { schoolId: school.id, name: `Old ${tag()}`, startsOn: new Date('2025-09-01'), endsOn: new Date('2026-06-30') },
      });
      // The migration's statement: SELECT asms_seed_year_results(school_id, id) per year; twice.
      for (let i = 0; i < 2; i++) {
        await testDb().$executeRaw`SELECT asms_seed_year_results(${school.id}::bigint, ${year.id}::bigint)`;
      }
      const terms = await testDb().academicTerm.findMany({
        where: { schoolId: school.id, academicYearId: year.id },
        orderBy: { sortOrder: 'asc' },
      });
      expect(terms.map((t) => [t.name, t.startsOn.toISOString().slice(0, 10), t.endsOn.toISOString().slice(0, 10), t.createdBy])).toEqual([
        ['Mid-term', '2025-09-01', '2026-01-30', null],
        ['Annual', '2026-01-31', '2026-06-30', null],
      ]);
      expect(await testDb().resultSettings.count({ where: { schoolId: school.id, academicYearId: year.id } })).toBe(1);
    });

    it('a new term takes what the others leave of 100, and the order follows the dates', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const [mid, annual] = await termsOf(s, yearId);
      expect((await patch(`/terms/${mid!.id}`, { name: 'First term', endsOn: '2026-07-31' }, s)).status).toBe(200);
      expect((await patch(`/terms/${annual!.id}`, { startsOn: '2026-12-01', weight: 60 }, s)).status).toBe(200);
      const created = await post(`/academic-years/${yearId}/terms`, { name: 'Second term', startsOn: '2026-08-01', endsOn: '2026-11-30' }, s);
      expect(created.status).toBe(201);
      expect(created.body as Term).toMatchObject({ name: 'Second term', sortOrder: 2, weight: 0, createdByUser: true });
      expect((await termsOf(s, yearId)).map((t) => [t.name, t.sortOrder, t.weight])).toEqual([
        ['First term', 1, 50],
        ['Second term', 2, 0],
        ['Annual', 3, 60],
      ]);
      const audit = await auditFor(s.school.id, 'academic_term', (created.body as Term).id);
      expect(audit.map((a) => a.action)).toEqual(['academic_term.created']);
      expect((await auditFor(s.school.id, 'academic_term', mid!.id)).map((a) => a.action)).toEqual(['academic_term.updated']);
    });

    it('refuses an overlap, a date outside the year, a taken name and a seventh term', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const [mid, annual] = await termsOf(s, yearId);
      const overlap = await post(`/academic-years/${yearId}/terms`, { name: 'Extra', startsOn: '2026-09-15', endsOn: '2026-10-15' }, s);
      expect([overlap.status, errorOf(overlap).code, errorOf(overlap).details.termId]).toEqual([409, 'TERM_OVERLAPS', mid!.id]);
      const outside = await patch(`/terms/${annual!.id}`, { endsOn: '2027-04-01' }, s);
      expect([outside.status, errorOf(outside).code, errorOf(outside).details.termId]).toEqual([409, 'TERM_OUTSIDE_YEAR', annual!.id]);
      const name = await patch(`/terms/${annual!.id}`, { name: 'mid-TERM' }, s);
      expect([name.status, errorOf(name).code]).toEqual([409, 'TERM_NAME_TAKEN']);
      const backwards = await patch(`/terms/${annual!.id}`, { endsOn: '2026-09-01' }, s);
      expect([backwards.status, fieldsOf(backwards)]).toEqual([422, ['endsOn:INVALID_VALUE']]);

      // Six short terms fill the year's start; a seventh is refused.
      await patch(`/terms/${mid!.id}`, { endsOn: '2026-04-01' }, s);
      for (const day of ['02', '03', '04', '05']) {
        const res = await post(`/academic-years/${yearId}/terms`, { name: `T${day}`, startsOn: `2026-04-${day}`, endsOn: `2026-04-${day}` }, s);
        expect(res.status).toBe(201);
      }
      const seventh = await post(`/academic-years/${yearId}/terms`, { name: 'T06', startsOn: '2026-04-06', endsOn: '2026-04-06' }, s);
      expect([seventh.status, fieldsOf(seventh)]).toEqual([422, ['startsOn:INVALID_VALUE']]);
      expect((await termsOf(s, yearId)).map((t) => t.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('a year cannot move its dates past a term, and a closed year takes no term', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const [, annual] = await termsOf(s, yearId);
      const shrink = await patch(`/academic-years/${yearId}`, { endsOn: '2027-02-28' }, s);
      expect([shrink.status, errorOf(shrink).code, errorOf(shrink).details.termId]).toEqual([409, 'TERM_OUTSIDE_YEAR', annual!.id]);
      expect((await patch(`/academic-years/${yearId}`, { endsOn: '2027-04-30' }, s)).status).toBe(200);
      expect((await post(`/academic-years/${yearId}/close`, {}, s)).status).toBe(200);
      const closed = await post(`/academic-years/${yearId}/terms`, { name: 'Late', startsOn: '2027-04-01', endsOn: '2027-04-30' }, s);
      expect([closed.status, errorOf(closed).code]).toEqual([409, 'ACADEMIC_YEAR_CLOSED']);
    });

    it('the database holds the same lines (the rest are in setup-guards.e2e-spec.ts)', async () => {
      const s = await signIn();
      const yearId = BigInt(await newYear(s));
      const db = testDb();
      const base = { schoolId: s.school.id, academicYearId: yearId, weight: 0, sortOrder: 3 };
      await expect(
        db.academicTerm.create({ data: { ...base, name: 'X', startsOn: new Date('2026-05-01'), endsOn: new Date('2026-05-02') } }),
      ).rejects.toThrow(/academic_terms_no_overlap/);
      await expect(
        db.$executeRaw`UPDATE academic_terms SET ends_on = '2027-05-01' WHERE school_id = ${s.school.id} AND academic_year_id = ${yearId} AND sort_order = 2`,
      ).rejects.toThrow(/a term lies inside its academic year/);
      await expect(
        db.$executeRaw`UPDATE result_settings SET test_weight = 30 WHERE school_id = ${s.school.id}`,
      ).rejects.toThrow(/result_settings_weights_check/);
    });
  });

  describe('not held for a class (§1.1)', () => {
    it('skips and unskips a class of the term’s year, idempotently, audited', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const classId = await newClass(s, yearId);
      const [mid] = await termsOf(s, yearId);
      const skip = await post(`/terms/${mid!.id}/skip-class`, { classId, reason: 'Nursery has no mid-term' }, s);
      expect(skip.status).toBe(200);
      expect((skip.body as Term).skippedClasses).toEqual([
        expect.objectContaining({ classId, reason: 'Nursery has no mid-term' }),
      ]);
      expect((await post(`/terms/${mid!.id}/skip-class`, { classId, reason: 'Again' }, s)).status).toBe(200);
      const lifted = await post(`/terms/${mid!.id}/unskip-class`, { classId, reason: 'Held after all' }, s);
      expect((lifted.body as Term).skippedClasses).toEqual([]);
      expect((await post(`/terms/${mid!.id}/unskip-class`, { classId, reason: 'Again' }, s)).status).toBe(200);
      const audit = await auditFor(s.school.id, 'academic_term', mid!.id);
      expect(audit.map((a) => [a.action, a.reason, (a.metadata as { held: boolean }).held])).toEqual([
        ['academic_term.skipped', 'Nursery has no mid-term', false],
        ['academic_term.skipped', 'Held after all', true],
      ]);
      // Skipping again after lifting is a new row; the lifted one stays as history.
      expect((await post(`/terms/${mid!.id}/skip-class`, { classId, reason: 'Not held again' }, s)).status).toBe(200);
      expect(await testDb().termSkip.count({ where: { schoolId: s.school.id, classId: BigInt(classId) } })).toBe(2);

      const otherYear = await newYear(s, { startsOn: '2027-04-01', endsOn: '2028-03-31' });
      const foreignClass = await newClass(s, otherYear);
      const wrong = await post(`/terms/${mid!.id}/skip-class`, { classId: foreignClass, reason: 'Other year' }, s);
      expect([wrong.status, fieldsOf(wrong)]).toEqual([422, ['classId:REFERENCE_NOT_FOUND']]);
    });
  });

  describe('R255: result settings', () => {
    it('weights sum to 100, bands are validated whole, and a change is audited', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const path = `/academic-years/${yearId}/result-settings`;
      const half = await patch(path, { testWeight: 30 }, s);
      expect([half.status, fieldsOf(half)]).toEqual([422, ['testWeight:INVALID_VALUE']]);
      const badBands = await patch(path, { bands: [{ grade: 'A', minPercent: 50 }, { grade: 'B', minPercent: 60 }, { grade: 'F', minPercent: 0 }] }, s);
      expect([badBands.status, fieldsOf(badBands)]).toEqual([422, ['bands:INVALID_VALUE']]);
      const noZero = await patch(path, { bands: [{ grade: 'P', minPercent: 33 }] }, s);
      expect([noZero.status, fieldsOf(noZero)]).toEqual([422, ['bands:INVALID_VALUE']]);
      // Security LOW-2: a grade label outside [A-Za-z0-9+-]{1,4} is refused by the DTO itself.
      const badLabel = await patch(path, { bands: [{ grade: '<b>', minPercent: 0 }] }, s);
      expect(badLabel.status).toBe(422);
      expect(fieldsOf(badLabel).every((f) => f.startsWith('bands'))).toBe(true);
      expect(fieldsOf(badLabel).length).toBeGreaterThan(0);
      const ok = await patch(
        path,
        {
          testWeight: 30,
          examWeight: 70,
          passPercent: 33,
          passRule: 'overall',
          bands: [{ grade: 'P', minPercent: 33 }, { grade: 'F', minPercent: 0 }],
          withholdCardForDues: true,
        },
        s,
      );
      expect(ok.status).toBe(200);
      expect(ok.body as Settings).toMatchObject({
        testWeight: 30,
        examWeight: 70,
        passPercent: 33,
        passRule: 'overall',
        bands: [{ grade: 'P', minPercent: 33 }, { grade: 'F', minPercent: 0 }],
        withholdCardForDues: true,
      });
      // A repeat changes nothing and writes no row.
      expect((await patch(path, { passPercent: 33 }, s)).status).toBe(200);
      const row = await testDb().resultSettings.findFirstOrThrow({ where: { schoolId: s.school.id, academicYearId: BigInt(yearId) } });
      const audit = await auditFor(s.school.id, 'result_settings', row.id);
      expect(audit.map((a) => a.action)).toEqual(['result_settings.updated']);
      expect((audit[0]?.metadata as { changes: Record<string, unknown> }).changes).toMatchObject({
        bands: { from: 'A+:90 A:80 B:70 C:60 D:50 E:40 F:0', to: 'P:33 F:0' },
      });
    });
  });

  describe('R257: a class subject list, ordered, archived not deleted', () => {
    it('sets, re-orders and archives the list (a reason for removal), and lists it in print order', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const classId = await newClass(s, yearId);
      const [maths, english, urdu] = [await newSubject(s), await newSubject(s), await newSubject(s)];
      const set = await patch(
        `/classes/${classId}`,
        { subjects: [{ subjectId: english, sortOrder: 2 }, { subjectId: maths, sortOrder: 1, examMaxMarks: 75 }, { subjectId: urdu, sortOrder: 3 }] },
        s,
      );
      expect(set.status).toBe(200);
      const list = async () => ((await get(`/classes/${classId}/subjects`, s)).body as { data: ClassSubject[] }).data;
      expect((await list()).map((c) => [c.subjectId, c.sortOrder, c.examMaxMarks])).toEqual([
        [maths, 1, 75],
        [english, 2, 100],
        [urdu, 3, 100],
      ]);

      const noReason = await patch(`/classes/${classId}`, { subjects: [{ subjectId: maths, sortOrder: 1 }] }, s);
      expect([noReason.status, fieldsOf(noReason)]).toEqual([422, ['reason:INVALID_VALUE']]);
      const removed = await patch(
        `/classes/${classId}`,
        { subjects: [{ subjectId: maths, sortOrder: 2, examMaxMarks: 75 }, { subjectId: english, sortOrder: 1 }], reason: 'Urdu moves to the next year' },
        s,
      );
      expect(removed.status).toBe(200);
      expect((await list()).map((c) => c.subjectId)).toEqual([english, maths]);
      const rows = await testDb().classSubject.findMany({ where: { schoolId: s.school.id, classId: BigInt(classId) }, orderBy: { id: 'asc' } });
      expect(rows.map((r) => [r.subjectId.toString(), r.archivedAt !== null])).toEqual([
        [english, false],
        [maths, false],
        [urdu, true],
      ]);
      // Re-adding an archived subject is a new row; the archived one is history.
      expect((await patch(`/classes/${classId}`, { subjects: [{ subjectId: english, sortOrder: 1 }, { subjectId: maths, sortOrder: 2, examMaxMarks: 75 }, { subjectId: urdu, sortOrder: 3 }] }, s)).status).toBe(200);
      expect(await testDb().classSubject.count({ where: { schoolId: s.school.id, classId: BigInt(classId) } })).toBe(4);

      const audit = (await auditFor(s.school.id, 'class', classId)).filter((a) => a.action !== 'class.created');
      expect(audit.map((a) => [a.action, a.reason])).toEqual([
        ['class.subjects_updated', null],
        ['class.subjects_updated', 'Urdu moves to the next year'],
        ['class.subjects_updated', null],
      ]);
      expect(audit[1]?.metadata).toMatchObject({ added: 0, changed: 2, removed: 1, removedSubjectIds: urdu });
    });

    it('refuses a duplicate, an unknown or archived subject, and an archived row is frozen', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const classId = await newClass(s, yearId);
      const maths = await newSubject(s);
      const dup = await patch(`/classes/${classId}`, { subjects: [{ subjectId: maths, sortOrder: 1 }, { subjectId: maths, sortOrder: 2 }] }, s);
      expect([dup.status, fieldsOf(dup)]).toEqual([422, ['subjects[1].subjectId:INVALID_VALUE']]);
      const other = await signIn();
      const foreign = await newSubject(other);
      const unknown = await patch(`/classes/${classId}`, { subjects: [{ subjectId: foreign, sortOrder: 1 }] }, s);
      expect([unknown.status, fieldsOf(unknown)]).toEqual([422, ['subjects[0].subjectId:REFERENCE_NOT_FOUND']]);
      const archivedSubject = await newSubject(s);
      expect((await post(`/subjects/${archivedSubject}/archive`, { reason: 'No longer taught' }, s)).status).toBe(200);
      const archived = await patch(`/classes/${classId}`, { subjects: [{ subjectId: archivedSubject, sortOrder: 1 }] }, s);
      expect([archived.status, fieldsOf(archived)]).toEqual([422, ['subjects[0].subjectId:REFERENCE_NOT_FOUND']]);
      const bad = await patch(`/classes/${classId}`, { subjects: [{ subjectId: maths, sortOrder: 1, examMaxMarks: 1001 }] }, s);
      expect(bad.status).toBe(422);
      // The year and the subject list never change in one request, even to the same year.
      const otherYear = await newYear(s);
      for (const academicYearId of [otherYear, yearId]) {
        const both = await patch(`/classes/${classId}`, { academicYearId, subjects: [{ subjectId: maths, sortOrder: 1 }] }, s);
        expect([both.status, fieldsOf(both)]).toEqual([422, ['subjects:INVALID_VALUE']]);
        expect(errorOf(both).details.fields?.[0]?.message).toBe('Change the year and the subjects in separate requests');
      }
      expect(await testDb().classSubject.count({ where: { schoolId: s.school.id, classId: BigInt(classId) } })).toBe(0);

      expect((await patch(`/classes/${classId}`, { subjects: [{ subjectId: maths, sortOrder: 1 }] }, s)).status).toBe(200);
      expect((await patch(`/classes/${classId}`, { subjects: [], reason: 'Dropped' }, s)).status).toBe(200);
      await expect(
        testDb().$executeRaw`UPDATE class_subjects SET sort_order = 5 WHERE school_id = ${s.school.id} AND class_id = ${BigInt(classId)}`,
      ).rejects.toThrow(/sort_order is frozen on class_subjects once archived_at is set/);
    });

    it('the next class and the final flag (rule 30)', async () => {
      const s = await signIn();
      const yearId = await newYear(s);
      const nextYear = await newYear(s, { startsOn: '2027-04-01', endsOn: '2028-03-31' });
      const five = await newClass(s, yearId);
      const six = await newClass(s, nextYear);
      const linked = await patch(`/classes/${five}`, { nextClassId: six }, s);
      expect(linked.status).toBe(200);
      expect(linked.body).toMatchObject({ nextClassId: six, isFinal: false });
      const both = await patch(`/classes/${five}`, { isFinal: true }, s);
      expect([both.status, fieldsOf(both)]).toEqual([422, ['isFinal:INVALID_VALUE']]);
      const self = await patch(`/classes/${five}`, { nextClassId: five }, s);
      expect([self.status, fieldsOf(self)]).toEqual([422, ['nextClassId:REFERENCE_NOT_FOUND']]);
      const final = await patch(`/classes/${five}`, { nextClassId: null, isFinal: true }, s);
      expect(final.status).toBe(200);
      expect(final.body).toMatchObject({ nextClassId: null, nextClassName: null, isFinal: true });
      const audit = await auditFor(s.school.id, 'class', five);
      expect(audit.map((a) => a.action)).toEqual(['class.created', 'class.updated', 'class.updated']);
    });
  });

  describe('access', () => {
    it('any staff member reads; only assessment.define writes terms and settings; class.manage writes subjects', async () => {
      const principal = await signIn();
      const yearId = await newYear(principal);
      const classId = await newClass(principal, yearId);
      const [mid] = await termsOf(principal, yearId);
      for (const role of ['teacher', 'office_staff'] as const) {
        const staff = await signIn(role, principal.school);
        expect((await get(`/academic-years/${yearId}/terms`, staff)).status).toBe(200);
        expect((await get(`/academic-years/${yearId}/result-settings`, staff)).status).toBe(200);
        expect((await get(`/classes/${classId}/subjects`, staff)).status).toBe(200);
        const writes = [
          await post(`/academic-years/${yearId}/terms`, { name: 'X', startsOn: '2026-04-01', endsOn: '2026-04-02' }, staff),
          await patch(`/terms/${mid!.id}`, { name: 'X' }, staff),
          await post(`/terms/${mid!.id}/skip-class`, { classId, reason: 'Not held' }, staff),
          await patch(`/academic-years/${yearId}/result-settings`, { passPercent: 50 }, staff),
          await patch(`/classes/${classId}`, { subjects: [] }, staff),
        ];
        expect(writes.map((r) => [r.status, errorOf(r).code])).toEqual(writes.map(() => [403, 'PERMISSION_DENIED']));
      }
    });

    it('another school’s year, term or class is 404', async () => {
      const owner = await signIn();
      const yearId = await newYear(owner);
      const classId = await newClass(owner, yearId);
      const [mid] = await termsOf(owner, yearId);
      const intruder = await signIn();
      const responses = [
        await get(`/academic-years/${yearId}/terms`, intruder),
        await get(`/academic-years/${yearId}/result-settings`, intruder),
        await get(`/classes/${classId}/subjects`, intruder),
        await patch(`/terms/${mid!.id}`, { name: 'Mine' }, intruder),
        await post(`/terms/${mid!.id}/skip-class`, { classId, reason: 'Mine now' }, intruder),
        await patch(`/academic-years/${yearId}/result-settings`, { passPercent: 1 }, intruder),
        await post(`/academic-years/${yearId}/terms`, { name: 'Mine', startsOn: '2026-04-01', endsOn: '2026-04-02' }, intruder),
      ];
      expect(responses.map((r) => r.status)).toEqual(responses.map(() => 404));
    });
  });
});
