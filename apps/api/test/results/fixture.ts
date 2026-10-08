// Wave O raw fixtures (contracts/slice-31.md §8): sheets, remarks, results and result subjects
// written straight through the guarded client on top of the wave-N marks fixture, for the
// direct-write guard suite and the isolation suite.
import type { ResultSheetStatus } from '@asms/shared';
import { createSchoolUser } from '../support/school-session';
import { testDb } from '../support/schools';
import type { MarksFixture } from '../academics/assessment-fixture';

export const BANDS = [
  { grade: 'A', minPercent: 80 },
  { grade: 'F', minPercent: 0 },
];

/** A draft Mid-term sheet of the fixture's section (or the final sheet with `termId: null`). */
export async function createSheet(
  f: MarksFixture,
  termId: bigint | null = f.midTermId,
): Promise<{ id: bigint }> {
  const row = await testDb().resultSheet.create({
    data: {
      schoolId: f.school.id,
      academicYearId: f.yearId,
      termId,
      classId: f.classId,
      sectionId: f.sectionId,
      createdBy: f.userId,
    },
  });
  return { id: row.id };
}

/** Moves a draft term sheet along the edges to `to`, decided by a second principal. */
export async function moveSheet(
  f: MarksFixture,
  sheetId: bigint,
  to: ResultSheetStatus,
): Promise<bigint> {
  const db = testDb();
  const where = { schoolId: f.school.id, id: sheetId };
  const decider = (await createSchoolUser(db, f.school, { systemRole: 'principal' })).userId;
  await db.resultSheet.updateMany({
    where,
    data: { status: 'submitted', submittedBy: f.userId, submittedAt: new Date() },
  });
  if (to === 'submitted') return decider;
  if (to === 'returned') {
    await db.resultSheet.updateMany({
      where,
      data: {
        status: 'returned',
        decidedBy: decider,
        decidedAt: new Date(),
        returnReason: 'Check again',
      },
    });
    return decider;
  }
  await db.resultSheet.updateMany({
    where,
    data: {
      status: 'approved',
      decidedBy: decider,
      decidedAt: new Date(),
      testWeight: 20,
      examWeight: 80,
      passPercent: 40,
      passRule: 'all_subjects',
      bands: BANDS,
    },
  });
  if (to === 'published') {
    await db.resultSheet.updateMany({
      where,
      data: { status: 'published', publishedBy: decider, publishedAt: new Date() },
    });
  }
  return decider;
}

/** One result with one subject on an approved (or published) sheet, for the fixture's enrolment. */
export async function createResult(
  f: MarksFixture,
  sheetId: bigint,
  termId: bigint | null = f.midTermId,
): Promise<{ id: bigint }> {
  const db = testDb();
  const row = await db.result.create({
    data: {
      schoolId: f.school.id,
      sheetId,
      enrolmentId: f.enrolmentId,
      studentId: f.studentId,
      academicYearId: f.yearId,
      termId,
      totalObtained: 75,
      totalMax: 100,
      percentBp: 7500,
      grade: 'F',
      passed: true,
      position: 1,
      positionOf: 1,
    },
  });
  await db.resultSubject.create({
    data: {
      schoolId: f.school.id,
      resultId: row.id,
      classId: f.classId,
      classSubjectId: f.classSubjectId,
      subjectName: 'Mathematics',
      sortOrder: 1,
      percentBp: 7500,
      obtained: 75,
      max: 100,
      grade: 'F',
      status: 'assessed',
    },
  });
  return { id: row.id };
}
