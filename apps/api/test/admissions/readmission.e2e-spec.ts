// POST /students/:id/readmit end to end (contracts/slice-6.md §3.7, R26, R28, R29, R36, R37).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { loadEnv } from '../../src/config/env';
import { EnrolmentRepository } from '../../src/repositories/enrolment.repository';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  randomIdentityDigits,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createGuardian,
  createStudent,
  enrol,
  isoDay,
  linkGuardian,
  type TestSection,
  type TestStudent,
} from '../support/students';

const ORIGIN = new URL(loadEnv().APP_URL).origin;

interface ErrorBody {
  error: { code: string; details: { fields?: { path: string }[]; from?: string } | null };
}
interface Detail {
  id: string;
  admissionNo: string;
  status: string;
  current: { sectionId: string; rollNo: number | null } | null;
}

describe('readmission (e2e)', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let section: TestSection;
  let office: string;
  let officeUserId: bigint;
  const db = testDb();
  const http = () => request(app.getHttpServer());
  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

  const readmit = (id: bigint, body: object, cookie = office) =>
    http()
      .post(`/api/v1/students/${id}/readmit`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(body);

  const target = (over: Record<string, unknown> = {}) => ({
    classId: section.classId.toString(),
    sectionId: section.id.toString(),
    reason: 'Family returned to the city',
    ...over,
  });

  /** A former student with an old (left) enrolment and a live primary, fee-paying guardian. */
  async function former(
    status: 'withdrawn' | 'transferred' | 'alumni' = 'withdrawn',
    link: { isPrimaryContact?: boolean; isFeePayer?: boolean } | null = {},
  ): Promise<TestStudent> {
    const student = await createStudent(db, school, { status, admittedOn: isoDay(-100) });
    await enrol(db, school, student, section, {
      status: 'left',
      startedOn: isoDay(-100),
      endedOn: isoDay(-30),
    });
    await db.studentStatusChange.create({
      data: {
        schoolId: school.id,
        studentId: student.id,
        fromStatus: 'active',
        toStatus: status,
        reason: 'Moved away',
        changedBy: officeUserId,
        effectiveOn: new Date(`${isoDay(-30)}T00:00:00.000Z`),
      },
    });
    if (link) await linkGuardian(db, school, student, await createGuardian(db, school), link);
    return student;
  }

  beforeAll(async () => {
    app = await createTestApp();
    school = await createSchool();
    ({ section } = await createClassWithSection(db, school));
    const user = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    officeUserId = user.userId;
    office = (await createSchoolSession(db, school, user)).cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('200: active again, a new enrolment, the same admission number, a status row and an audit row', async () => {
    const student = await former('transferred');
    const res = await readmit(student.id, target({ rollNo: 12 }));
    expect(res.status).toBe(200);
    const detail = res.body as Detail;
    expect(detail).toMatchObject({
      id: student.id.toString(),
      admissionNo: student.admissionNo,
      status: 'active',
      current: { sectionId: section.id.toString(), rollNo: 12 },
    });
    const enrolments = await db.enrolment.findMany({
      where: { schoolId: school.id, studentId: student.id },
      orderBy: { id: 'asc' },
    });
    expect(enrolments.map((e) => e.status)).toEqual(['left', 'active']);
    expect(enrolments[1]?.startedOn.toISOString().slice(0, 10)).toBe(isoDay());
    const change = await db.studentStatusChange.findFirst({
      where: { schoolId: school.id, studentId: student.id },
      orderBy: { id: 'desc' },
    });
    expect(change).toMatchObject({
      fromStatus: 'transferred',
      toStatus: 'active',
      reason: 'Family returned to the city',
    });
    const audit = await db.auditLog.findFirst({
      where: { schoolId: school.id, action: 'student.readmitted', subjectId: student.id },
    });
    expect(audit?.reason).toBe('Family returned to the city');
    expect(audit?.metadata).toMatchObject({
      fromStatus: 'transferred',
      sectionId: section.id.toString(),
    });
  });

  it('a resubmit is 409 ILLEGAL_STATUS_TRANSITION and opens no second enrolment', async () => {
    const student = await former('alumni');
    expect((await readmit(student.id, target())).status).toBe(200);
    const again = await readmit(student.id, target());
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('ILLEGAL_STATUS_TRANSITION');
    expect(
      await db.enrolment.count({
        where: { schoolId: school.id, studentId: student.id, status: 'active' },
      }),
    ).toBe(1);
  });

  it('409 for an active or suspended student', async () => {
    for (const status of ['active', 'suspended'] as const) {
      const student = await createStudent(db, school, { status });
      const res = await readmit(student.id, target());
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('ILLEGAL_STATUS_TRANSITION');
    }
  });

  it('R28, R29: the kept links must still have a primary contact and a fee payer', async () => {
    const noLinks = await former('withdrawn', null);
    expect(errorOf(await readmit(noLinks.id, target())).code).toBe('PRIMARY_CONTACT_REQUIRED');
    const noPayer = await former('withdrawn', { isPrimaryContact: true, isFeePayer: false });
    expect(errorOf(await readmit(noPayer.id, target())).code).toBe('FEE_PAYER_REQUIRED');
    const after = await db.student.findFirst({ where: { schoolId: school.id, id: noPayer.id } });
    expect(after?.status).toBe('withdrawn');
  });

  it('422: a date before leaving or in the future, a reason holding an identity number', async () => {
    const student = await former();
    for (const [over, path] of [
      [{ readmittedOn: isoDay(-60) }, 'readmittedOn'],
      [{ readmittedOn: isoDay(5) }, 'readmittedOn'],
      [{ reason: `B-Form ${randomIdentityDigits()}` }, 'reason'],
      [{ reason: 'no' }, 'reason'],
    ] as const) {
      const res = await readmit(student.id, target(over));
      expect(res.status).toBe(422);
      expect(errorOf(res).details?.fields?.[0]?.path).toBe(path);
    }
  });

  it('409 ROLL_NO_TAKEN; 404 for another school; 403 for a teacher', async () => {
    const holder = await createStudent(db, school);
    await enrol(db, school, holder, section, { rollNo: 99 });
    const student = await former();
    expect(errorOf(await readmit(student.id, target({ rollNo: 99 }))).code).toBe('ROLL_NO_TAKEN');

    const other = await createSchool();
    const otherUser = await createSchoolUser(db, other, { systemRole: 'office_staff' });
    const otherCookie = (await createSchoolSession(db, other, otherUser)).cookie;
    expect((await readmit(student.id, target(), otherCookie)).status).toBe(404);

    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const teacherCookie = (await createSchoolSession(db, school, teacher)).cookie;
    expect((await readmit(student.id, target(), teacherCookie)).status).toBe(403);
  });

  it('A1: a roll number taken after the in-transaction check is ROLL_NO_TAKEN naming the holder', async () => {
    const holder = await createStudent(db, school);
    const held = await enrol(db, school, holder, section, { rollNo: 77 });
    const student = await former();
    // Force the race: the check misses the holder, the insert hits the unique index.
    const enrolments = app.get(EnrolmentRepository, { strict: false });
    const spy = jest.spyOn(enrolments, 'findActiveByRollNo').mockResolvedValueOnce(null);
    const res = await readmit(student.id, target({ rollNo: 77 }));
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('ROLL_NO_TAKEN');
    expect((errorOf(res).details as { enrolmentId?: string } | null)?.enrolmentId).toBe(
      held.id.toString(),
    );
    const after = await db.student.findFirst({ where: { schoolId: school.id, id: student.id } });
    expect(after?.status).toBe('withdrawn');
  });
});
