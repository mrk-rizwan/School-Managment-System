// /api/v1/students end to end (contracts/slice-6.md §1-§3): list, detail, B-Form lookup, PATCH,
// change-status (R36), status history, issue-login (R40) and teacher scope (R79), over the real
// AppModule, access guard and database.
import { PasswordHasher } from '../../src/common/crypto/password';
import { loadEnv } from '../../src/config/env';
import { StudentRepository } from '../../src/repositories/student.repository';
import {
  createSchoolSession,
  randomIdentityDigits,
  testIdentityHash,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createSection,
  createStudent,
  createTeacherAssignment,
  day,
  enrol,
  isoDay,
} from '../support/students';
import {
  admitted,
  auditFor,
  createHarness,
  errorOf,
  ID,
  setStudentLogin,
  signIn,
  type Harness,
  type Signed,
} from './support';

interface Student {
  id: string;
  admissionNo: string;
  fullName: string;
  gender: string;
  dateOfBirth: string;
  hasBForm: boolean;
  bFormMasked: string | null;
  status: string;
  admittedOn: string;
  current: {
    enrolmentId: string;
    academicYearId: string;
    classId: string;
    sectionId: string;
    rollNo: number | null;
  } | null;
  userId: string | null;
  notes?: string | null;
  photoDocumentId?: string | null;
}
interface Page<T> {
  data: T[];
  total: number;
}

const masked = (d: string) => `${d.slice(0, 5)}-*****-${d.slice(12)}`;
const dashed = (d: string) => `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;

describe('students (e2e)', () => {
  let h: Harness;
  const db = testDb();
  /** Every B-Form used in the run: none may appear in a body or a log line (R16). */
  const secrets: string[] = [];
  const bForm = () => {
    const digits = randomIdentityDigits();
    secrets.push(digits);
    return digits;
  };

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    for (const digits of secrets) {
      for (const text of [...h.bodies, ...h.logs]) {
        expect(text).not.toContain(digits);
        expect(text).not.toContain(dashed(digits));
      }
    }
    await h.app.close();
    await closeTestDb();
  });

  const list = async (query: string, who: Signed) =>
    (await h.get(`/students?${query}`, who.cookie)).body as Page<Student>;
  const ids = async (query: string, who: Signed) => (await list(query, who)).data.map((s) => s.id);

  /** A school with a section and an office user. */
  async function setup() {
    const school = await createSchool();
    const office = await signIn(school, 'office_staff');
    const structure = await createClassWithSection(db, school);
    return { school, office, ...structure };
  }

  // ------------------------------------------------------------------------------ access

  it('401 without a session; a teacher may not write or look up', async () => {
    const { school, section } = await setup();
    const { student } = await admitted(school, section);
    expect((await h.get('/students', '')).status).toBe(401);
    const teacher = await signIn(school, 'teacher');
    const writes: [string, object][] = [
      [
        `/students/${student.id}/change-status`,
        { status: 'suspended', reason: 'x y z', effectiveOn: isoDay() },
      ],
      ['/students/lookup', { bForm: randomIdentityDigits() }],
      [`/students/${student.id}/issue-login`, {}],
      [`/students/${student.id}/guardian-links`, {}],
    ];
    for (const [path, body] of writes) {
      expect(errorOf(await h.send('post', path, body, teacher.cookie)).code).toBe(
        'PERMISSION_DENIED',
      );
    }
    const patch = await h.send(
      'patch',
      `/students/${student.id}`,
      { fullName: 'No Way' },
      teacher.cookie,
    );
    expect(patch.status).toBe(403);
  });

  it('R79: a teacher sees only active students of their sections; anything else is 404', async () => {
    const { school, klass, section } = await setup();
    const other = await createSection(db, school, klass);
    const mine = await admitted(school, section, { fullName: 'Mine Student' });
    const theirs = await admitted(school, other, { fullName: 'Theirs Student' });
    const left = await createStudent(db, school, { fullName: 'Left Student' });
    await enrol(db, school, left, section, { status: 'left' });

    // No assignment: no rows, every id 404 (an empty scope is no rows, never no filter).
    const teacher = await signIn(school, 'teacher');
    expect(await list('', teacher)).toMatchObject({ data: [], total: 0 });
    expect((await h.get(`/students/${mine.student.id}`, teacher.cookie)).status).toBe(404);

    await createTeacherAssignment(db, school, teacher, { role: 'class_teacher', section });
    expect(await ids('', teacher)).toEqual([mine.student.id.toString()]);
    for (const path of ['', '/guardian-links', '/enrolments', '/status-changes']) {
      expect((await h.get(`/students/${mine.student.id}${path}`, teacher.cookie)).status).toBe(200);
      for (const id of [theirs.student.id, left.id]) {
        const res = await h.get(`/students/${id}${path}`, teacher.cookie);
        expect({ path, status: res.status, code: errorOf(res).code }).toEqual({
          path,
          status: 404,
          code: 'NOT_FOUND',
        });
      }
    }

    // A teacher sees no B-Form, no notes, no photo id, and guardian name, phone and flags only.
    const detail = (await h.get(`/students/${mine.student.id}`, teacher.cookie)).body as Student;
    expect(detail).toMatchObject({
      hasBForm: true,
      bFormMasked: null,
      notes: null,
      photoDocumentId: null,
    });
    const links = (await h.get(`/students/${mine.student.id}/guardian-links`, teacher.cookie))
      .body as Page<Record<string, unknown>>;
    expect(links.data[0]).toMatchObject({
      guardianId: mine.guardian.id.toString(),
      phone: mine.guardian.phone,
      isPrimaryContact: true,
      contactCapability: null,
      guardianCnicMasked: null,
      guardianAddress: null,
      guardianUserId: null,
    });
  });

  // ------------------------------------------------------------------------------- list

  it('GET list filters, searches and sorts; a B-Form in q is 422 pointing at the lookup', async () => {
    const { school, office, year, klass, section } = await setup();
    const second = await createSection(db, school, klass);
    const a = await admitted(school, section, { fullName: 'Asma Khan', rollNo: 2 });
    const b = await admitted(school, second, { fullName: 'Bilal Raza', bForm: null });
    const c = await admitted(school, section, { fullName: 'Chand Bibi', rollNo: 1 });
    const d = await createStudent(db, school, {
      fullName: 'Dawood Suspended',
      status: 'suspended',
      gender: 'female',
    });
    const idsOf = (...rows: { id: bigint }[]) => rows.map((r) => r.id.toString());

    expect(await list('', office)).toMatchObject({ total: 4 });
    expect(await ids('', office)).toEqual(idsOf(a.student, b.student, c.student, d));
    expect(await ids('sort=-fullName', office)).toEqual(idsOf(d, c.student, b.student, a.student));
    expect(await ids('sort=rollNo', office)).toEqual(idsOf(c.student, a.student, b.student, d));
    expect(await ids('status=suspended', office)).toEqual(idsOf(d));
    expect(await ids(`sectionId=${section.id}`, office)).toEqual(idsOf(a.student, c.student));
    expect(await ids(`classId=${klass.id}&academicYearId=${year.id}`, office)).toEqual(
      idsOf(a.student, b.student, c.student),
    );
    expect(await ids('sectionId=999999999999', office)).toEqual([]);
    expect(await ids('gender=female', office)).toEqual(idsOf(d));
    expect(await ids('hasBForm=false', office)).toEqual(idsOf(b.student));
    expect(await ids('hasLogin=true', office)).toEqual([]);
    expect(await ids('q=bilal', office)).toEqual(idsOf(b.student));
    expect(await ids(`q=${a.student.admissionNo.slice(0, 6)}`, office)).toContain(
      a.student.id.toString(),
    );
    expect(await ids(`admittedOnFrom=${isoDay(1)}`, office)).toEqual([]);
    expect(await ids(`admittedOnTo=${isoDay()}`, office)).toHaveLength(4);

    const row = (await list(`sectionId=${section.id}&sort=rollNo`, office)).data[0];
    expect(row).toMatchObject({
      id: c.student.id.toString(),
      status: 'active',
      current: {
        enrolmentId: c.enrolment.id.toString(),
        academicYearId: year.id.toString(),
        classId: klass.id.toString(),
        sectionId: section.id.toString(),
        rollNo: 1,
      },
    });

    for (const query of [
      `q=${randomIdentityDigits()}`,
      `q=${dashed(randomIdentityDigits())}`,
      'q=a',
      'sort=rollno',
      'status=gone',
      'hasBForm=yes',
      'admittedOnFrom=2026-02-30',
      'classId=abc',
      'unknown=1',
    ]) {
      expect({ query, status: (await h.get(`/students?${query}`, office.cookie)).status }).toEqual({
        query,
        status: 422,
      });
    }
  });

  it('GET :id gives the detail with the masked B-Form and notes to the office; 404 across schools', async () => {
    const { school, office, section } = await setup();
    const digits = bForm();
    const { student } = await admitted(school, section, { bForm: digits });
    await db.student.update({
      where: { schoolId_id: { schoolId: school.id, id: student.id } },
      data: { notes: 'Allergic to peanuts' },
    });
    const res = await h.get(`/students/${student.id}`, office.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: student.id.toString(),
      admissionNo: student.admissionNo,
      hasBForm: true,
      bFormMasked: masked(digits),
      notes: 'Allergic to peanuts',
      photoDocumentId: null,
      userId: null,
    });
    const otherSchool = await createSchool();
    const intruder = await signIn(otherSchool, 'principal');
    for (const path of ['', '/guardian-links', '/enrolments', '/status-changes']) {
      expect((await h.get(`/students/${student.id}${path}`, intruder.cookie)).status).toBe(404);
    }
    expect((await h.get('/students/abc', office.cookie)).status).toBe(404);
  });

  // ----------------------------------------------------------------------------- lookup

  it('lookup by B-Form: one hit with readmissible (R26), a miss, never across schools (R25)', async () => {
    const { school, office, section } = await setup();
    const activeDigits = bForm();
    const leftDigits = bForm();
    const { student } = await admitted(school, section, { bForm: activeDigits });
    const gone = await createStudent(db, school, { bForm: leftDigits, status: 'withdrawn' });

    const hit = await h.send(
      'post',
      '/students/lookup',
      { bForm: dashed(activeDigits) },
      office.cookie,
    );
    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({
      data: [
        {
          student: expect.objectContaining({ id: student.id.toString(), status: 'active' }),
          readmissible: false,
        },
      ],
      truncated: false,
    });
    const readmit = await h.send('post', '/students/lookup', { bForm: leftDigits }, office.cookie);
    expect(readmit.body).toMatchObject({
      data: [{ student: { id: gone.id.toString() }, readmissible: true }],
    });
    const miss = await h.send('post', '/students/lookup', { bForm: bForm() }, office.cookie);
    expect(miss.body).toEqual({ data: [], truncated: false });

    // The same digits in another school are another student (R25), invisible from here.
    const otherSchool = await createSchool();
    await createStudent(db, otherSchool, { bForm: activeDigits });
    const otherOffice = await signIn(otherSchool, 'office_staff');
    const there = await h.send(
      'post',
      '/students/lookup',
      { bForm: activeDigits },
      otherOffice.cookie,
    );
    expect((there.body as { data: { student: Student }[] }).data[0]?.student.id).not.toBe(
      student.id.toString(),
    );

    for (const body of [{}, { bForm: '123' }, { bForm: null }, { bForm: activeDigits, x: 1 }]) {
      expect((await h.send('post', '/students/lookup', body, office.cookie)).status).toBe(422);
    }
  });

  it('a B-Form patch spends the identity-probe budget the lookups spend; other patches do not', async () => {
    const school = await createSchool();
    const office = await signIn(school, 'office_staff');
    const student = await createStudent(db, school);
    const path = `/students/${student.id}`;
    // Spent across the routes that share one bucket: guardian lookups, student lookups, patches.
    for (let i = 0; i < 10; i++) {
      expect(
        (await h.send('post', '/guardians/lookup', { phone: '03000000000' }, office.cookie)).status,
      ).toBe(200);
    }
    for (let i = 0; i < 10; i++) {
      expect(
        (await h.send('post', '/students/lookup', { bForm: '1111111111111' }, office.cookie))
          .status,
      ).toBe(200);
    }
    for (let i = 0; i < 10; i++) {
      expect((await h.send('patch', path, { bForm: bForm() }, office.cookie)).status).toBe(200);
    }
    const limited = await h.send('patch', path, { bForm: bForm() }, office.cookie);
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    expect(
      (await h.send('post', '/students/lookup', { bForm: '1111111111111' }, office.cookie)).status,
    ).toBe(429);
    // A patch without a B-Form neither counts nor is refused.
    expect((await h.send('patch', path, { fullName: 'Ayesha Noor' }, office.cookie)).status).toBe(
      200,
    );
  });

  it('lookup is throttled per user: 30 a minute, then 429', async () => {
    const school = await createSchool();
    const office = await signIn(school, 'office_staff');
    for (let i = 0; i < 30; i++) {
      expect(
        (await h.send('post', '/students/lookup', { bForm: '1111111111111' }, office.cookie))
          .status,
      ).toBe(200);
    }
    const limited = await h.send(
      'post',
      '/students/lookup',
      { bForm: '1111111111111' },
      office.cookie,
    );
    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe('RATE_LIMITED');
    const peer = await signIn(school, 'office_staff');
    expect(
      (await h.send('post', '/students/lookup', { bForm: '1111111111111' }, peer.cookie)).status,
    ).toBe(200);
  });

  // ------------------------------------------------------------------------------ PATCH

  it('PATCH edits, clears, audits real changes only and never the B-Form digits', async () => {
    const { school, office, section } = await setup();
    const { student } = await admitted(school, section, { bForm: null });
    const digits = bForm();
    const path = `/students/${student.id}`;

    const res = await h.send(
      'patch',
      path,
      {
        fullName: '  Ayesha   Noor ',
        gender: 'female',
        dateOfBirth: '2017-01-15',
        bForm: dashed(digits),
        notes: 'Left-handed',
      },
      office.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fullName: 'Ayesha Noor',
      gender: 'female',
      dateOfBirth: '2017-01-15',
      hasBForm: true,
      bFormMasked: masked(digits),
      notes: 'Left-handed',
    });
    const row = await db.student.findFirst({ where: { schoolId: school.id, id: student.id } });
    expect(row?.bForm).toMatch(/^v1:/);
    expect(row?.bFormHash).toBe(testIdentityHash(digits));

    // The same values again: no write, no second audit row.
    await h.send('patch', path, { fullName: 'Ayesha Noor', bForm: digits }, office.cookie);
    const cleared = await h.send('patch', path, { bForm: null, notes: null }, office.cookie);
    expect(cleared.body).toMatchObject({ hasBForm: false, bFormMasked: null, notes: null });

    const audits = await auditFor(school, 'student', student.id);
    expect(audits.map((a) => a.action)).toEqual(['student.updated', 'student.updated']);
    expect(audits[0]?.metadata).toEqual({
      changes: {
        fullName: { from: expect.any(String), to: 'Ayesha Noor' },
        gender: { from: 'male', to: 'female' },
        dateOfBirth: { from: '2018-05-01', to: '2017-01-15' },
        bForm: { changed: true },
        notes: { changed: true },
      },
    });
    expect(audits[1]?.metadata).toEqual({
      changes: { bForm: { changed: true }, notes: { changed: true } },
    });
  });

  it('PATCH 422: null on required fields, impossible or out-of-range dates, unknown fields', async () => {
    const { school, office, section } = await setup();
    const { student } = await admitted(school, section, { admittedOn: isoDay(-10) });
    const thirtyOneYears = new Date();
    thirtyOneYears.setUTCFullYear(thirtyOneYears.getUTCFullYear() - 31);
    const cases: [object, string][] = [
      [{ fullName: null }, 'fullName'],
      [{ gender: null }, 'gender'],
      [{ dateOfBirth: null }, 'dateOfBirth'],
      [{ gender: 'other' }, 'gender'],
      [{ dateOfBirth: '2019-02-29' }, 'dateOfBirth'],
      [{ dateOfBirth: isoDay(2) }, 'dateOfBirth'],
      [{ dateOfBirth: thirtyOneYears.toISOString().slice(0, 10) }, 'dateOfBirth'],
      // Not before the admission date (CHECK students_date_of_birth_check).
      [{ dateOfBirth: isoDay(-5) }, 'dateOfBirth'],
      [{ bForm: '1234' }, 'bForm'],
      [{ notes: `Call ${randomIdentityDigits()}` }, 'notes'],
      [{ status: 'withdrawn' }, 'status'],
    ];
    for (const [body, field] of cases) {
      const res = await h.send('patch', `/students/${student.id}`, body, office.cookie);
      expect({ field, status: res.status }).toEqual({ field, status: 422 });
      const paths = ((errorOf(res).details?.fields ?? []) as { path: string }[]).map((f) => f.path);
      expect(paths).toContain(field);
    }
  });

  it('PATCH bForm: taken is 409 STUDENT_BFORM_EXISTS (R25); locked once a login exists', async () => {
    const { school, office, section } = await setup();
    const holderDigits = bForm();
    const holder = await admitted(school, section, { bForm: holderDigits });
    const { student } = await admitted(school, section, { bForm: null });
    const taken = await h.send(
      'patch',
      `/students/${student.id}`,
      { bForm: holderDigits },
      office.cookie,
    );
    expect(taken.status).toBe(409);
    expect(errorOf(taken)).toMatchObject({
      code: 'STUDENT_BFORM_EXISTS',
      details: { studentId: holder.student.id.toString() },
    });

    await db.user.create({
      data: {
        schoolId: school.id,
        usernameHash: testIdentityHash(holderDigits),
        passwordHash: await new PasswordHasher(loadEnv()).hash(holderDigits),
        studentId: holder.student.id,
      },
    });
    for (const value of [bForm(), null, holderDigits]) {
      const locked = await h.send(
        'patch',
        `/students/${holder.student.id}`,
        { bForm: value },
        office.cookie,
      );
      expect(errorOf(locked).code).toBe('STUDENT_BFORM_LOCKED');
    }
    const name = await h.send(
      'patch',
      `/students/${holder.student.id}`,
      { fullName: 'Still Editable' },
      office.cookie,
    );
    expect(name.status).toBe(200);
  });

  it('R25 race: a B-Form taken between the check and the write is the same 409, never a 500', async () => {
    const { school, office, section } = await setup();
    const digits = bForm();
    const holder = await admitted(school, section, { bForm: digits });
    const { student } = await admitted(school, section, { bForm: null });
    // The pre-check misses the holder once, so the update hits students_school_id_b_form_hash_key.
    jest.spyOn(StudentRepository.prototype, 'findByBFormHash').mockResolvedValueOnce(null);
    const res = await h.send('patch', `/students/${student.id}`, { bForm: digits }, office.cookie);
    jest.restoreAllMocks();
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: 'STUDENT_BFORM_EXISTS',
      details: { studentId: holder.student.id.toString() },
    });
    expect(await auditFor(school, 'student', student.id)).toEqual([]);
  });

  // ---------------------------------------------------------------------- change-status

  it('R36: active → suspended keeps the enrolment; suspended → active; resubmit is 409 from = to', async () => {
    const { school, office, section } = await setup();
    const { student, enrolment } = await admitted(school, section, { admittedOn: isoDay(-30) });
    const path = `/students/${student.id}/change-status`;
    const suspend = await h.send(
      'post',
      path,
      { status: 'suspended', reason: 'Fees unpaid', effectiveOn: isoDay(-2) },
      office.cookie,
    );
    expect(suspend.status).toBe(200);
    expect(suspend.body).toMatchObject({
      status: 'suspended',
      current: { enrolmentId: enrolment.id.toString() },
    });

    const again = await h.send(
      'post',
      path,
      { status: 'suspended', reason: 'Fees unpaid', effectiveOn: isoDay(-2) },
      office.cookie,
    );
    expect(errorOf(again)).toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      details: { from: 'suspended', to: 'suspended' },
    });
    // R36 literal: suspended → withdrawn is refused; reactivate first.
    const direct = await h.send(
      'post',
      path,
      { status: 'withdrawn', reason: 'Moving away', effectiveOn: isoDay() },
      office.cookie,
    );
    expect(errorOf(direct)).toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      details: { from: 'suspended', to: 'withdrawn' },
    });

    // Not before the last status change.
    const early = await h.send(
      'post',
      path,
      { status: 'active', reason: 'Fees paid', effectiveOn: isoDay(-3) },
      office.cookie,
    );
    expect(early.status).toBe(422);
    const back = await h.send(
      'post',
      path,
      { status: 'active', reason: 'Fees paid', effectiveOn: isoDay() },
      office.cookie,
    );
    expect(back.body).toMatchObject({ status: 'active' });

    const history = (await h.get(`/students/${student.id}/status-changes`, office.cookie))
      .body as Page<Record<string, unknown>>;
    expect(history.total).toBe(2);
    expect(history.data.map((r) => [r.fromStatus, r.toStatus])).toEqual([
      ['suspended', 'active'],
      ['active', 'suspended'],
    ]);
    expect(history.data[1]).toMatchObject({
      id: expect.stringMatching(ID),
      reason: 'Fees unpaid',
      effectiveOn: isoDay(-2),
      changedBy: office.userId.toString(),
      changedByName: expect.stringContaining('Test office_staff'),
    });
    const audits = await auditFor(school, 'student', student.id);
    expect(audits.map((a) => [a.action, a.reason])).toEqual([
      ['student.status_changed', 'Fees unpaid'],
      ['student.status_changed', 'Fees paid'],
    ]);
    expect(audits[0]?.metadata).toEqual({
      from: 'active',
      to: 'suspended',
      effectiveOn: isoDay(-2),
      enrolmentClosed: false,
    });
  });

  it('R36: withdrawn closes the active enrolment; back to active only through readmission', async () => {
    const { school, office, section } = await setup();
    const { student, enrolment } = await admitted(school, section, { admittedOn: isoDay(-30) });
    const path = `/students/${student.id}/change-status`;
    const res = await h.send(
      'post',
      path,
      { status: 'withdrawn', reason: 'Family moved', effectiveOn: isoDay(-1) },
      office.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'withdrawn', current: null });
    const row = await db.enrolment.findFirst({ where: { schoolId: school.id, id: enrolment.id } });
    expect(row).toMatchObject({ status: 'left', endedOn: day(isoDay(-1)) });
    const [audit] = await auditFor(school, 'student', student.id);
    expect(audit?.metadata).toMatchObject({ enrolmentClosed: true });

    const back = await h.send(
      'post',
      path,
      { status: 'active', reason: 'Came back', effectiveOn: isoDay() },
      office.cookie,
    );
    expect(errorOf(back)).toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      details: { from: 'withdrawn', to: 'active', hint: 'readmit' },
    });
    for (const status of ['alumni', 'transferred', 'suspended']) {
      const refused = await h.send(
        'post',
        path,
        { status, reason: 'Not allowed', effectiveOn: isoDay() },
        office.cookie,
      );
      expect(errorOf(refused).code).toBe('ILLEGAL_STATUS_TRANSITION');
    }
  });

  it('R36: → alumni is year end only; transferred closes the enrolment too', async () => {
    const { school, office, section } = await setup();
    const { student } = await admitted(school, section);
    const path = `/students/${student.id}/change-status`;
    const alumni = await h.send(
      'post',
      path,
      { status: 'alumni', reason: 'Graduated', effectiveOn: isoDay() },
      office.cookie,
    );
    expect(errorOf(alumni)).toMatchObject({
      code: 'ILLEGAL_STATUS_TRANSITION',
      details: { from: 'active', to: 'alumni' },
    });
    const moved = await h.send(
      'post',
      path,
      { status: 'transferred', reason: 'Other school', effectiveOn: isoDay() },
      office.cookie,
    );
    expect(moved.body).toMatchObject({ status: 'transferred', current: null });
  });

  it('change-status 422: effectiveOn in the future, before admission or the enrolment start; bad reason', async () => {
    const { school, office, section } = await setup();
    const student = await createStudent(db, school, { admittedOn: isoDay(-20) });
    await enrol(db, school, student, section, { startedOn: isoDay(-10) });
    const path = `/students/${student.id}/change-status`;
    for (const [body, field] of [
      [{ status: 'suspended', reason: 'Too early', effectiveOn: isoDay(2) }, 'effectiveOn'],
      [{ status: 'suspended', reason: 'Too early', effectiveOn: isoDay(-25) }, 'effectiveOn'],
      [{ status: 'suspended', reason: 'Too early', effectiveOn: isoDay(-15) }, 'effectiveOn'],
      [{ status: 'suspended', reason: 'no', effectiveOn: isoDay() }, 'reason'],
      [{ status: 'suspended', effectiveOn: isoDay() }, 'reason'],
      [{ status: 'gone', reason: 'Bad status', effectiveOn: isoDay() }, 'status'],
    ] as const) {
      const res = await h.send('post', path, body, office.cookie);
      expect({ field, status: res.status }).toEqual({ field, status: 422 });
    }
    expect(
      (
        await h.send(
          'post',
          path,
          { status: 'suspended', reason: 'Fine now', effectiveOn: isoDay(-10) },
          office.cookie,
        )
      ).status,
    ).toBe(200);
  });

  it('leaving active revokes the student login’s sessions', async () => {
    const { school, office, section } = await setup();
    const digits = bForm();
    const { student } = await admitted(school, section, { bForm: digits });
    const user = await db.user.create({
      data: {
        schoolId: school.id,
        usernameHash: testIdentityHash(digits),
        passwordHash: await new PasswordHasher(loadEnv()).hash(digits),
        studentId: student.id,
      },
    });
    await createSchoolSession(db, school, { userId: user.id });
    await h.send(
      'post',
      `/students/${student.id}/change-status`,
      { status: 'suspended', reason: 'Conduct', effectiveOn: isoDay() },
      office.cookie,
    );
    expect(
      await db.session.count({ where: { schoolId: school.id, userId: user.id, revokedAt: null } }),
    ).toBe(0);
  });

  // ------------------------------------------------------------------------ issue-login

  it('R40: issue-login creates the student login once, with the B-Form as username', async () => {
    const { school, office, section } = await setup();
    const digits = bForm();
    const { student } = await admitted(school, section, { bForm: digits, fullName: 'Sana Iqbal' });
    const path = `/students/${student.id}/issue-login`;

    await setStudentLogin(school, false);
    expect(errorOf(await h.send('post', path, undefined, office.cookie)).code).toBe(
      'STUDENT_LOGIN_DISABLED',
    );
    await setStudentLogin(school, true);

    const res = await h.send('post', path, undefined, office.cookie);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.stringMatching(ID),
      staffId: null,
      guardianId: null,
      studentId: student.id.toString(),
      fullName: 'Sana Iqbal',
      systemRoles: [],
      status: 'active',
      passwordIsDefault: true,
    });
    const userId = BigInt((res.body as { id: string }).id);
    const row = await db.user.findFirst({ where: { schoolId: school.id, id: userId } });
    expect(row?.usernameHash).toBe(testIdentityHash(digits));
    expect(await new PasswordHasher(loadEnv()).verify(row?.passwordHash ?? '', digits)).toBe(true);
    const [audit] = await auditFor(school, 'user', userId);
    expect(audit).toMatchObject({
      action: 'user.login_issued',
      actorUserId: office.userId,
      metadata: { capacity: 'student', linkedExistingUser: false },
    });
    expect(((await h.get(`/students/${student.id}`, office.cookie)).body as Student).userId).toBe(
      userId.toString(),
    );
    expect(await ids('hasLogin=true', office)).toEqual([student.id.toString()]);

    expect(errorOf(await h.send('post', path, undefined, office.cookie)).code).toBe(
      'LOGIN_ALREADY_EXISTS',
    );
  });

  it('R40: issue-login refusals in order, and never a link to an existing user', async () => {
    const { school, office, section } = await setup();
    await setStudentLogin(school, true);
    const issue = (id: bigint) =>
      h.send('post', `/students/${id}/issue-login`, undefined, office.cookie);

    const suspended = await createStudent(db, school, { status: 'suspended', bForm: bForm() });
    expect(errorOf(await issue(suspended.id)).code).toBe('STUDENT_NOT_ACTIVE');
    const noBForm = await admitted(school, section, { bForm: null });
    expect(errorOf(await issue(noBForm.student.id)).code).toBe('IDENTITY_NUMBER_MISSING');

    // A B-Form equal to a staff CNIC: refused, the staff login untouched.
    const staff = await signIn(school, 'teacher');
    secrets.push(staff.cnic);
    const clash = await admitted(school, section, { bForm: staff.cnic });
    const res = await issue(clash.student.id);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('USERNAME_IN_USE');
    expect(
      await db.user.findFirst({ where: { schoolId: school.id, id: staff.userId } }),
    ).toMatchObject({ studentId: null });
    expect(await db.user.count({ where: { schoolId: school.id, studentId: { not: null } } })).toBe(
      0,
    );

    // Unknown and other-school ids are 404; a teacher has no user.account.manage.
    expect((await issue(999999999999n)).status).toBe(404);
    const teacher = await signIn(school, 'teacher');
    expect(
      (
        await h.send(
          'post',
          `/students/${noBForm.student.id}/issue-login`,
          undefined,
          teacher.cookie,
        )
      ).status,
    ).toBe(403);
  });

  it('R40: two racing issue-logins create one user; the loser gets LOGIN_ALREADY_EXISTS', async () => {
    const { school, office, section } = await setup();
    await setStudentLogin(school, true);
    const { student } = await admitted(school, section, { bForm: bForm() });
    const path = `/students/${student.id}/issue-login`;
    const [one, two] = await Promise.all([
      h.send('post', path, undefined, office.cookie),
      h.send('post', path, undefined, office.cookie),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    expect(errorOf(one.status === 409 ? one : two).code).toBe('LOGIN_ALREADY_EXISTS');
    expect(await db.user.count({ where: { schoolId: school.id, studentId: student.id } })).toBe(1);
  });

  it('a student login is not a staff session: student routes refuse it (R78)', async () => {
    const { school, office, section } = await setup();
    await setStudentLogin(school, true);
    const { student } = await admitted(school, section, { bForm: bForm() });
    const issued = await h.send(
      'post',
      `/students/${student.id}/issue-login`,
      undefined,
      office.cookie,
    );
    const user = { userId: BigInt((issued.body as { id: string }).id) };
    const { cookie } = await createSchoolSession(db, school, user);
    expect([401, 403]).toContain((await h.get('/students', cookie)).status);
  });

  // ------------------------------------------------------------------------- isolation

  it('control 4: every write route 404s another school’s student', async () => {
    const { school, section } = await setup();
    const { student } = await admitted(school, section, { bForm: bForm() });
    const other: TestSchool = await createSchool();
    await setStudentLogin(other, true);
    const intruder = await signIn(other, 'principal');
    const cases: ['post' | 'patch', string, object][] = [
      ['patch', `/students/${student.id}`, { fullName: 'Taken Over' }],
      [
        'post',
        `/students/${student.id}/change-status`,
        { status: 'suspended', reason: 'Intrusion', effectiveOn: isoDay() },
      ],
      ['post', `/students/${student.id}/issue-login`, {}],
    ];
    for (const [method, path, body] of cases) {
      expect({ path, status: (await h.send(method, path, body, intruder.cookie)).status }).toEqual({
        path,
        status: 404,
      });
    }
    const row = await db.student.findFirst({ where: { schoolId: school.id, id: student.id } });
    expect(row).toMatchObject({ status: 'active', fullName: expect.not.stringContaining('Taken') });
  });
});
