// Fixtures for the wave-E attendance tables (migration 20261004120000_phase2_attendance_diary),
// written through the guarded client exactly as slice 11's repositories will: every write names
// its school.
import type { SchoolId } from '../../src/tenancy/school-id';
import type { testDb, TestSchool } from '../support/schools';
import { day, type TestSection } from '../support/students';

type GuardedPrismaClient = ReturnType<typeof testDb>;

export const asSchool = (id: SchoolId): TestSchool => ({ id, shortCode: '' });

export async function createRegister(
  db: GuardedPrismaClient,
  schoolId: SchoolId,
  section: TestSection,
  submittedBy: bigint,
  opts: { date?: string; period?: number } = {},
): Promise<{ id: bigint; date: Date; period: number }> {
  return db.attendanceRegister.create({
    data: {
      schoolId,
      sectionId: section.id,
      classId: section.classId,
      academicYearId: section.academicYearId,
      date: day(opts.date ?? '2026-09-01'),
      period: opts.period ?? 1,
      mode: 'daily',
      submittedBy,
      source: 'web',
    },
    select: { id: true, date: true, period: true },
  });
}

export async function createMark(
  db: GuardedPrismaClient,
  schoolId: SchoolId,
  register: { id: bigint; date: Date; period: number },
  enrolmentId: bigint,
  status: 'present' | 'absent' | 'late' | 'on_leave' = 'present',
): Promise<{ id: bigint }> {
  return db.attendanceMark.create({
    data: {
      schoolId,
      registerId: register.id,
      enrolmentId,
      date: register.date,
      period: register.period,
      status,
    },
    select: { id: true },
  });
}

/**
 * Updates a history-tracked row inside one interactive transaction that first names the actor
 * and reason as transaction-local settings, as ChangeContextRepository does for the services.
 */
export function withChangeContext<T>(
  db: GuardedPrismaClient,
  actorUserId: bigint,
  reason: string | null,
  work: (tx: Parameters<Parameters<GuardedPrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('asms.actor_user_id', ${actorUserId.toString()}, true),
             set_config('asms.change_reason', ${reason ?? ''}, true)`;
    return work(tx);
  });
}
