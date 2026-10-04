// Control 4 / R62 for the wave-E attendance tables (migration
// 20261004120000_phase2_attendance_diary). No repository exists yet, so each probe drives the
// guarded client exactly as a tenant repository will: every read and write filters on school_id.
// Slices 11 and 12 replace the probes with their repositories' methods and keep the titles. Each
// table also proves a composite foreign key: a row in school B cannot name school A's parent row.
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createClassWithSection, createStudent, day, enrol } from '../support/students';
import { asSchool, createMark, createRegister, withChangeContext } from './support';

const db = () => testDb();

/** A section with one enrolled child and a teacher login, in `schoolId`. */
async function classroom(schoolId: SchoolId) {
  const school = asSchool(schoolId);
  const { section } = await createClassWithSection(db(), school);
  const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
  const student = await createStudent(db(), school);
  const enrolment = await enrol(db(), school, student, section);
  return { section, teacher, student, enrolment };
}

/** A register with one mark for the classroom's child. */
async function marked(schoolId: SchoolId) {
  const room = await classroom(schoolId);
  const register = await createRegister(db(), schoolId, room.section, room.teacher.userId);
  const mark = await createMark(db(), schoolId, register, room.enrolment.id, 'absent');
  return { ...room, register, mark };
}

describe('Phase 2 attendance tenant isolation', () => {
  afterAll(() => closeTestDb());

  it('attendance_registers: a register written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    let roomA: Awaited<ReturnType<typeof classroom>> | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        roomA ??= room;
        return (await createRegister(db(), schoolId, room.section, room.teacher.userId)).id;
      },
      read: (schoolId, id) => db().attendanceRegister.findFirst({ where: { schoolId, id } }),
      list: (schoolId) =>
        db().attendanceRegister.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().attendanceRegister.updateMany({
            where: { schoolId, id },
            data: { lastAmendedBy: roomA?.teacher.userId ?? 0n, lastAmendedAt: new Date() },
          })
        ).count,
      snapshot: (row) => (row as { lastAmendedAt: Date | null } | null)?.lastAmendedAt,
    });
    // School B cannot record its register against school A's section.
    const teacherB = await createSchoolUser(db(), schools.b, { systemRole: 'teacher' });
    if (!roomA) throw new Error('missing');
    await expect(createRegister(db(), schools.b.id, roomA.section, teacherB.userId)).rejects.toThrow(
      /attendance_registers_(class|section)_id_fkey/,
    );
  });

  it('attendance_marks: a mark written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    let registerA: Awaited<ReturnType<typeof createRegister>> | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const row = await marked(schoolId);
        registerA ??= row.register;
        return row.mark.id;
      },
      read: (schoolId, id) => db().attendanceMark.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().attendanceMark.findMany({ where: { schoolId }, select: { id: true } }),
      // arrived_at is not history-tracked, so the owner's own write would need no actor.
      write: async (schoolId, id) =>
        (
          await db().attendanceMark.updateMany({
            where: { schoolId, id },
            data: { arrivedAt: new Date('1970-01-01T09:45:00Z') },
          })
        ).count,
      snapshot: (row) => (row as { arrivedAt: Date | null } | null)?.arrivedAt,
    });
    // School B cannot mark its child into school A's register.
    const roomB = await classroom(schools.b.id);
    if (!registerA) throw new Error('missing');
    await expect(createMark(db(), schools.b.id, registerA, roomB.enrolment.id)).rejects.toThrow(
      /attendance_marks_register_id_fkey/,
    );
  });

  it('attendance_mark_changes: a change written by school A’s trigger is invisible to school B', async () => {
    const schools = await createTwoSchools();
    const markOf = new Map<bigint, bigint>();
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const row = await marked(schoolId);
        await withChangeContext(db(), row.teacher.userId, 'Arrived late', (tx) =>
          tx.attendanceMark.updateMany({
            where: { schoolId, id: row.mark.id },
            data: { status: 'late' },
          }),
        );
        const change = await db().attendanceMarkChange.findFirstOrThrow({
          where: { schoolId, markId: row.mark.id },
          select: { id: true },
        });
        markOf.set(change.id, row.mark.id);
        return change.id;
      },
      read: (schoolId, id) => db().attendanceMarkChange.findFirst({ where: { schoolId, id } }),
      list: (schoolId) =>
        db().attendanceMarkChange.findMany({ where: { schoolId }, select: { id: true } }),
    });
    // An actor from another school cannot be recorded against school A's mark.
    const markId = [...markOf.values()][0];
    if (markId === undefined) throw new Error('missing');
    const outsider = await createSchoolUser(db(), schools.b, { systemRole: 'principal' });
    await expect(
      withChangeContext(db(), outsider.userId, 'Taken over', (tx) =>
        tx.attendanceMark.updateMany({
          where: { schoolId: schools.a.id, id: markId },
          data: { status: 'present' },
        }),
      ),
    ).rejects.toThrow(/attendance_mark_changes_changed_by_fkey/);
  });

  it('attendance_arrivals: an arrival written for school A is invisible to school B', async () => {
    const schools = await createTwoSchools();
    let markA: bigint | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const row = await marked(schoolId);
        markA ??= row.mark.id;
        return (
          await db().attendanceArrival.create({
            data: {
              schoolId,
              markId: row.mark.id,
              arrivedAt: new Date('1970-01-01T09:45:00Z'),
              recordedBy: row.teacher.userId,
            },
            select: { id: true },
          })
        ).id;
      },
      read: (schoolId, id) => db().attendanceArrival.findFirst({ where: { schoolId, id } }),
      list: (schoolId) =>
        db().attendanceArrival.findMany({ where: { schoolId }, select: { id: true } }),
    });
    const gateB = await createSchoolUser(db(), schools.b, { systemRole: 'office_staff' });
    if (markA === undefined) throw new Error('missing');
    await expect(
      db().attendanceArrival.create({
        data: {
          schoolId: schools.b.id,
          markId: markA,
          arrivedAt: new Date('1970-01-01T09:45:00Z'),
          recordedBy: gateB.userId,
        },
      }),
    ).rejects.toThrow(/attendance_arrivals_mark_id_fkey/);
  });

  it('attendance_alerts: an alert written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    const alert = (schoolId: SchoolId, enrolmentId: bigint, studentId: bigint) =>
      db().attendanceAlert.create({
        data: {
          schoolId,
          enrolmentId,
          studentId,
          date: day('2026-09-01'),
          kind: 'absence',
          dueAt: new Date('2026-09-01T04:30:00Z'),
        },
        select: { id: true },
      });
    let roomA: Awaited<ReturnType<typeof classroom>> | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        roomA ??= room;
        return (await alert(schoolId, room.enrolment.id, room.student.id)).id;
      },
      read: (schoolId, id) => db().attendanceAlert.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().attendanceAlert.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().attendanceAlert.updateMany({
            where: { schoolId, id },
            data: { status: 'cancelled', cancelReason: 'holiday' },
          })
        ).count,
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
    if (!roomA) throw new Error('missing');
    await expect(alert(schools.b.id, roomA.enrolment.id, roomA.student.id)).rejects.toThrow(
      /attendance_alerts_enrolment_id_fkey/,
    );
  });

  it('attendance_day_status: a day status written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    const status = (
      schoolId: SchoolId,
      room: Awaited<ReturnType<typeof classroom>>,
    ) =>
      db().attendanceDayStatus.create({
        data: {
          schoolId,
          enrolmentId: room.enrolment.id,
          studentId: room.student.id,
          sectionId: room.section.id,
          date: day('2026-09-01'),
          status: 'absent',
          periodsRecorded: 1,
          periodsPresent: 0,
          periodsLate: 0,
          periodsAbsent: 1,
          periodsLeave: 0,
        },
        select: { id: true },
      });
    let roomA: Awaited<ReturnType<typeof classroom>> | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        roomA ??= room;
        return (await status(schoolId, room)).id;
      },
      read: (schoolId, id) => db().attendanceDayStatus.findFirst({ where: { schoolId, id } }),
      list: (schoolId) =>
        db().attendanceDayStatus.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().attendanceDayStatus.updateMany({
            where: { schoolId, id },
            data: { status: 'late', periodsAbsent: 0, periodsLate: 1 },
          })
        ).count,
      snapshot: (row) => (row as { status: string } | null)?.status,
    });
    if (!roomA) throw new Error('missing');
    await expect(status(schools.b.id, roomA)).rejects.toThrow(/attendance_day_status_\w+_fkey/);
  });

  it('attendance_daily_summary: the summary row a mark creates for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    let roomA: Awaited<ReturnType<typeof marked>> | undefined;
    await expectIsolated(schools, {
      // The statement-level trigger creates the section-day row on the first mark.
      create: async (schoolId) => {
        const row = await marked(schoolId);
        roomA ??= row;
        return (
          await db().attendanceDailySummary.findFirstOrThrow({
            where: { schoolId, sectionId: row.section.id, date: row.register.date },
            select: { id: true },
          })
        ).id;
      },
      read: (schoolId, id) => db().attendanceDailySummary.findFirst({ where: { schoolId, id } }),
      list: (schoolId) =>
        db().attendanceDailySummary.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().attendanceDailySummary.updateMany({
            where: { schoolId, id },
            data: { computedVersion: 1n, absent: 1, computedAt: new Date() },
          })
        ).count,
      snapshot: (row) => (row as { computedVersion: bigint } | null)?.computedVersion,
    });
    if (!roomA) throw new Error('missing');
    await expect(
      db().attendanceDailySummary.create({
        data: {
          schoolId: schools.b.id,
          sectionId: roomA.section.id,
          classId: roomA.section.classId,
          academicYearId: roomA.section.academicYearId,
          date: day('2026-09-02'),
          mode: 'daily',
        },
      }),
    ).rejects.toThrow(/attendance_daily_summary_(class|section)_id_fkey/);
  });

  it('staff_attendance: a staff mark written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    const people = async (schoolId: SchoolId) => ({
      office: await createSchoolUser(db(), asSchool(schoolId), { systemRole: 'office_staff' }),
      teacher: await createSchoolUser(db(), asSchool(schoolId), { systemRole: 'teacher' }),
    });
    let teacherA: bigint | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const { office, teacher } = await people(schoolId);
        teacherA ??= teacher.staffId;
        return (
          await db().staffAttendance.create({
            data: {
              schoolId,
              staffId: teacher.staffId,
              date: day('2026-09-01'),
              status: 'present',
              markedBy: office.userId,
            },
            select: { id: true },
          })
        ).id;
      },
      read: (schoolId, id) => db().staffAttendance.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().staffAttendance.findMany({ where: { schoolId }, select: { id: true } }),
      // marked_at is not history-tracked.
      write: async (schoolId, id) =>
        (
          await db().staffAttendance.updateMany({
            where: { schoolId, id },
            data: { markedAt: new Date('2000-01-01T00:00:00Z') },
          })
        ).count,
      snapshot: (row) => (row as { markedAt: Date } | null)?.markedAt.toISOString(),
    });
    const officeB = await createSchoolUser(db(), schools.b, { systemRole: 'office_staff' });
    if (teacherA === undefined) throw new Error('missing');
    await expect(
      db().staffAttendance.create({
        data: {
          schoolId: schools.b.id,
          staffId: teacherA,
          date: day('2026-09-01'),
          status: 'absent',
          markedBy: officeB.userId,
        },
      }),
    ).rejects.toThrow(/staff_attendance_staff_id_fkey/);
  });

  it('staff_attendance_changes: a change written by school A’s trigger is invisible to school B', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const office = await createSchoolUser(db(), asSchool(schoolId), { systemRole: 'office_staff' });
        const teacher = await createSchoolUser(db(), asSchool(schoolId), { systemRole: 'teacher' });
        const row = await db().staffAttendance.create({
          data: {
            schoolId,
            staffId: teacher.staffId,
            date: day('2026-09-01'),
            status: 'absent',
            markedBy: office.userId,
          },
          select: { id: true },
        });
        await withChangeContext(db(), office.userId, 'Was on duty at the gate', (tx) =>
          tx.staffAttendance.updateMany({
            where: { schoolId, id: row.id },
            data: { status: 'present' },
          }),
        );
        return (
          await db().staffAttendanceChange.findFirstOrThrow({
            where: { schoolId, staffAttendanceId: row.id },
            select: { id: true },
          })
        ).id;
      },
      read: (schoolId, id) => db().staffAttendanceChange.findFirst({ where: { schoolId, id } }),
      list: (schoolId) =>
        db().staffAttendanceChange.findMany({ where: { schoolId }, select: { id: true } }),
    });
  });
});
