// Control 4 / R62 for staff attendance: StaffAttendanceRepository (contracts/slice-12.md), every
// read and write path, asked as another school. The tables' own isolation tests (direct client)
// are in test/attendance/isolation.e2e-spec.ts.
import { NestExpressApplication } from '@nestjs/platform-express';
import { StaffAttendanceRepository } from '../../src/repositories/staff-attendance.repository';
import { createTestApp } from '../core/app';
import { expectIsolated } from '../support/isolation';
import { withChangeContext } from '../attendance/support';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';

const db = () => testDb();
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const DATE = day('2026-09-01');

describe('Phase 2 staff attendance repository isolation', () => {
  let app: NestExpressApplication;
  let repo: StaffAttendanceRepository;

  beforeAll(async () => {
    app = await createTestApp();
    repo = app.get(StaffAttendanceRepository);
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('staff_attendance: a mark written through the repository for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    const { a, b } = schools;
    const inA = {
      office: await createSchoolUser(db(), a, { systemRole: 'office_staff' }),
      teacher: await createSchoolUser(db(), a, { systemRole: 'teacher' }),
    };
    const officeB = await createSchoolUser(db(), b, { systemRole: 'office_staff' });

    await expectIsolated(schools, {
      create: async (schoolId) => {
        await repo.create(schoolId, DATE, inA.office.userId, [
          { staffId: inA.teacher.staffId, status: 'present', note: null },
        ]);
        const [row] = await repo.marksOn(schoolId, DATE, [inA.teacher.staffId]);
        if (!row) throw new Error('missing');
        return row.id;
      },
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: async (schoolId) =>
        (await repo.daySheet(schoolId, { date: DATE, sort: 'fullName', skip: 0, take: 50 })).rows
          .flatMap((r) => (r.mark ? [r.mark] : [])),
      // Refused before any trigger: no row of this school has the id.
      write: async (schoolId, id) => {
        await repo.update(schoolId, id, { status: 'absent', note: null });
        return 1;
      },
      snapshot: (row) => (row as { status: string } | null)?.status,
    });

    const [own] = await repo.marksOn(a.id, DATE, [inA.teacher.staffId]);
    if (!own) throw new Error('missing');
    // Every other path, asked as school B, sees nothing of school A's row or member.
    expect(await repo.lock(b.id, own.id)).toBeNull();
    expect(await repo.lockDay(b.id, DATE, [inA.teacher.staffId])).toEqual([]);
    expect(await repo.marksOn(b.id, DATE, [inA.teacher.staffId])).toEqual([]);
    expect(await repo.history(b.id, inA.teacher.staffId, DATE, DATE)).toEqual([]);
    expect([...(await repo.markable(b.id, DATE, [inA.teacher.staffId]))]).toEqual([]);
    expect(await repo.daySummary(b.id, DATE)).toMatchObject({ marked: 0 });
    expect((await repo.daySummary(a.id, DATE)).marked).toBe(1);
    expect(
      (await repo.daySheet(b.id, { date: DATE, sort: 'status', skip: 0, take: 50 })).rows.map((r) => r.staffId),
    ).not.toContain(inA.teacher.staffId);

    // School B cannot mark school A's member: the composite foreign key refuses it.
    await expect(
      repo.create(b.id, DATE, officeB.userId, [
        { staffId: inA.teacher.staffId, status: 'present', note: null },
      ]),
    ).rejects.toThrow(/staff_attendance_staff_id_fkey/);
  });

  it('staff_attendance_changes: a change made in school A is read back only by school A', async () => {
    const schools = await createTwoSchools();
    const { a, b } = schools;
    const office = await createSchoolUser(db(), a, { systemRole: 'office_staff' });
    const teacher = await createSchoolUser(db(), a, { systemRole: 'teacher' });
    await repo.create(a.id, DATE, office.userId, [{ staffId: teacher.staffId, status: 'absent', note: null }]);
    const [row] = await repo.marksOn(a.id, DATE, [teacher.staffId]);
    if (!row) throw new Error('missing');
    await withChangeContext(db(), office.userId, 'Was on duty', (tx) =>
      tx.staffAttendance.updateMany({ where: { schoolId: a.id, id: row.id }, data: { status: 'present' } }),
    );
    expect(await repo.findById(a.id, row.id)).toMatchObject({ lastAmendedAt: expect.any(Date) });
    expect(await repo.findById(b.id, row.id)).toBeNull();
    expect(await repo.history(b.id, teacher.staffId, DATE, DATE)).toEqual([]);
    expect(
      await db().staffAttendanceChange.findMany({ where: { schoolId: b.id, staffAttendanceId: row.id } }),
    ).toEqual([]);
  });
});
