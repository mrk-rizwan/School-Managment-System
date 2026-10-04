// Control 4 / R62 for the wave-E diary and remark tables (migration
// 20261004120000_phase2_attendance_diary), at the table: each probe drives the guarded client and
// proves the composite foreign keys refuse a cross-school parent. The slice-13 repositories are
// held to the same standard through their own methods in repositories.e2e-spec.ts;
// diary_entry_changes has no repository (only the history trigger writes it), so its probe stays.
import type { SchoolId } from '../../src/tenancy/school-id';
import { asSchool, withChangeContext } from '../attendance/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import {
  createClassWithSection,
  createStudent,
  createSubject,
  day,
  enrol,
} from '../support/students';

const db = () => testDb();

async function classroom(schoolId: SchoolId) {
  const school = asSchool(schoolId);
  const { section } = await createClassWithSection(db(), school);
  const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
  const subject = await createSubject(db(), school);
  const student = await createStudent(db(), school);
  const enrolment = await enrol(db(), school, student, section);
  return { section, teacher, subject, student, enrolment };
}

type Classroom = Awaited<ReturnType<typeof classroom>>;

const entry = (schoolId: SchoolId, room: Classroom, sectionOf: Classroom = room) =>
  db().diaryEntry.create({
    data: {
      schoolId,
      sectionId: sectionOf.section.id,
      classId: sectionOf.section.classId,
      academicYearId: sectionOf.section.academicYearId,
      date: day('2026-09-01'),
      subjectId: room.subject.id,
      authorStaffId: room.teacher.staffId,
      topic: 'Fractions',
    },
    select: { id: true },
  });

const remark = (schoolId: SchoolId, room: Classroom, enrolmentOf: Classroom = room) =>
  db().remark.create({
    data: {
      schoolId,
      enrolmentId: enrolmentOf.enrolment.id,
      studentId: enrolmentOf.student.id,
      authorStaffId: room.teacher.staffId,
      date: day('2026-09-01'),
      category: 'homework',
      text: 'Homework not done.',
      visibility: 'guardian',
    },
    select: { id: true },
  });

describe('Phase 2 diary and remark tenant isolation', () => {
  afterAll(() => closeTestDb());

  it('diary_entries: an entry written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    let roomA: Classroom | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        roomA ??= room;
        return (await entry(schoolId, room)).id;
      },
      read: (schoolId, id) => db().diaryEntry.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().diaryEntry.findMany({ where: { schoolId }, select: { id: true } }),
      // updated_at is not history-tracked; the owner's own write would need no actor.
      write: async (schoolId, id) =>
        (
          await db().diaryEntry.updateMany({
            where: { schoolId, id },
            data: { updatedAt: new Date('2000-01-01T00:00:00Z') },
          })
        ).count,
      snapshot: (row) => (row as { updatedAt: Date } | null)?.updatedAt.toISOString(),
    });
    // School B cannot post into school A's section.
    const roomB = await classroom(schools.b.id);
    if (!roomA) throw new Error('missing');
    await expect(entry(schools.b.id, roomB, roomA)).rejects.toThrow(
      /diary_entries_(class|section)_id_fkey/,
    );
  });

  it('diary_entry_changes: a change written by school A’s trigger is invisible to school B', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        const { id } = await entry(schoolId, room);
        await withChangeContext(db(), room.teacher.userId, null, (tx) =>
          tx.diaryEntry.updateMany({ where: { schoolId, id }, data: { topic: 'Decimals' } }),
        );
        return (
          await db().diaryEntryChange.findFirstOrThrow({
            where: { schoolId, diaryEntryId: id },
            select: { id: true },
          })
        ).id;
      },
      read: (schoolId, id) => db().diaryEntryChange.findFirst({ where: { schoolId, id } }),
      list: (schoolId) =>
        db().diaryEntryChange.findMany({ where: { schoolId }, select: { id: true } }),
    });
  });

  it('remarks: a remark written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    let roomA: Classroom | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        roomA ??= room;
        return (await remark(schoolId, room)).id;
      },
      read: (schoolId, id) => db().remark.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().remark.findMany({ where: { schoolId }, select: { id: true } }),
      // Every column but superseded_at is frozen; that one needs a successor. B's write must
      // touch nothing (zero rows), so the trigger never runs.
      write: async (schoolId, id) =>
        (
          await db().remark.updateMany({
            where: { schoolId, id },
            data: { supersededAt: new Date() },
          })
        ).count,
      snapshot: (row) => (row as { supersededAt: Date | null } | null)?.supersededAt,
    });
    const roomB = await classroom(schools.b.id);
    if (!roomA) throw new Error('missing');
    await expect(remark(schools.b.id, roomB, roomA)).rejects.toThrow(/remarks_enrolment_id_fkey/);
  });
});
