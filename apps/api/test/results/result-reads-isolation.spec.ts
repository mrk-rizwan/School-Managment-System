// Control 4 / R62 for slice 33's read-only ResultReadsRepository (contracts/slice-33.md §4): a
// result, a sheet and a class-test mark written as school A are invisible to school B through every
// method the family routes, the student page and the reports use. Only the tenant key keeps the
// rows apart: the ids are school A's own.
import { Test } from '@nestjs/testing';
import { EnvModule } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { ResultReadsRepository } from '../../src/repositories/result-reads.repository';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import {
  createAssessment,
  createMark,
  createMarksFixture,
  type MarksFixture,
} from '../academics/assessment-fixture';
import { expectIsolated, studentsScope } from '../support/isolation';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createResult, createSheet, moveSheet } from './fixture';

async function readsRepository(): Promise<{ reads: ResultReadsRepository; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({
    imports: [EnvModule, TenancyModule, AccessModule],
    providers: [ResultReadsRepository],
  }).compile();
  await moduleRef.init();
  return { reads: moduleRef.get(ResultReadsRepository), close: () => moduleRef.close() };
}

/** A published, live Mid-term result of the fixture's student. */
async function publishedResult(f: MarksFixture): Promise<{ sheetId: bigint; resultId: bigint }> {
  const sheet = await createSheet(f);
  await moveSheet(f, sheet.id, 'approved');
  const result = await createResult(f, sheet.id);
  const now = new Date();
  await testDb().resultSheet.updateMany({
    where: { schoolId: f.school.id, id: sheet.id },
    data: { status: 'published', publishedBy: f.userId, publishedAt: now },
  });
  await testDb().result.updateMany({
    where: { schoolId: f.school.id, id: result.id },
    data: { publishedAt: now },
  });
  return { sheetId: sheet.id, resultId: result.id };
}

describe('result reads tenant isolation (slice 33)', () => {
  afterAll(() => closeTestDb());

  it('results: the family card check, the year summaries, the years and the student page', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const { reads, close } = await readsRepository();
    try {
      await expectIsolated(schools, {
        create: async () => (await publishedResult(f)).resultId,
        read: (schoolId, id) => reads.publishedLive(schoolId, f.studentId, id),
        list: (schoolId) => reads.summariesOfYear(schoolId, f.studentId, f.yearId),
      });
      expect(await reads.yearsWithResults(schools.a.id, f.studentId)).toHaveLength(1);
      expect(await reads.yearsWithResults(schools.b.id, f.studentId)).toEqual([]);
      expect((await reads.publishedIdsOfStudent(schools.a.id, f.studentId, 'any', { skip: 0, take: 50 })).total).toBe(1);
      expect(await reads.publishedIdsOfStudent(schools.b.id, f.studentId, 'any', { skip: 0, take: 50 })).toEqual({
        ids: [],
        total: 0,
      });
      expect(await reads.studentInScope(schools.a.id, studentsScope([f.studentId]), f.studentId)).toBe(true);
      expect(await reads.studentInScope(schools.b.id, studentsScope([f.studentId]), f.studentId)).toBe(false);
    } finally {
      await close();
    }
  });

  it('result_sheets and result_subjects: the section summary and the subject report', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const { reads, close } = await readsRepository();
    try {
      await expectIsolated(schools, {
        create: async () => (await publishedResult(f)).sheetId,
        read: (schoolId, id) => reads.reportSheet(schoolId, id),
      });
      const [sheet] = await testDb().resultSheet.findMany({ where: { schoolId: f.school.id } });
      if (!sheet) throw new Error('no sheet');
      expect(await reads.reportRows(schools.a.id, sheet.id)).toHaveLength(1);
      expect(await reads.reportRows(schools.b.id, sheet.id)).toEqual([]);
      expect(await reads.subjectRows(schools.a.id, f.midTermId, f.classSubjectId)).toHaveLength(1);
      expect(await reads.subjectRows(schools.b.id, f.midTermId, f.classSubjectId)).toEqual([]);
      expect(await reads.classSubjectOfTerm(schools.a.id, f.midTermId, f.classSubjectId)).not.toBeNull();
      expect(await reads.classSubjectOfTerm(schools.b.id, f.midTermId, f.classSubjectId)).toBeNull();
    } finally {
      await close();
    }
  });

  it('marks: the family class-test list', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const { reads, close } = await readsRepository();
    const list = async (schoolId: Parameters<ResultReadsRepository['testMarks']>[0]) =>
      (await reads.testMarks(schoolId, f.studentId, { skip: 0, take: 50 })).rows.map((r) => ({
        ...r,
        id: r.markId,
      }));
    try {
      await expectIsolated(schools, {
        create: async () => (await createMark(f, await createAssessment(f))).id,
        read: async (schoolId, id) => (await list(schoolId)).find((r) => r.id === id) ?? null,
        list,
      });
    } finally {
      await close();
    }
  });
});
