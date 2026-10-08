// Control 4 / R62 for the slice-35 tables: a row written as school A is invisible to, and
// unwritable by, school B, through PromotionRepository with a school-wide scope (so only the
// tenant key keeps the rows apart).
import { createMarksFixture } from '../academics/assessment-fixture';
import { expectIsolated } from '../support/isolation';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createAcademicYear } from '../support/students';
import { promotionRepositoryAs } from './support';

describe('promotion tenant isolation', () => {
  afterAll(() => closeTestDb());

  /** School A's fixture (a 2026-27 year, a section, an enrolled student) and a target year. */
  async function setUp() {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const target = await createAcademicYear(testDb(), schools.a, {
      startsOn: '2027-04-01',
      endsOn: '2028-03-31',
      status: 'planned',
    });
    const { repo, all, close } = await promotionRepositoryAs(schools.a, f.userId);
    const open = (schoolId: typeof schools.a.id) =>
      repo.create(
        schoolId,
        { academicYearId: f.yearId, classId: f.classId, sectionId: f.sectionId, targetYearId: target.id, openedBy: f.userId },
        [
          {
            enrolmentId: f.enrolmentId,
            studentId: f.studentId,
            resultId: null,
            proposed: null,
            decision: null,
            targetClassId: null,
            targetSectionId: null,
            arrearsFlag: false,
          },
        ],
      );
    return { schools, f, repo, all, close, open };
  }

  it('promotion_sheets', async () => {
    const { schools, f, repo, all, close, open } = await setUp();
    try {
      await expectIsolated(schools, {
        create: open,
        read: (schoolId, id) => repo.findById(schoolId, all, id),
        list: async (schoolId) => (await repo.list(schoolId, all, { descending: true, skip: 0, take: 50 })).rows,
        write: (schoolId, id) => repo.markApplied(schoolId, id, f.userId, new Date()),
        snapshot: (row) => (row as { status: string } | null)?.status ?? null,
      });
    } finally {
      await close();
    }
  });

  it('promotion_decisions', async () => {
    const { schools, f, repo, all, close, open } = await setUp();
    const sheetId = await open(schools.a.id);
    const rows = (schoolId: typeof schools.a.id) => repo.decisions(schoolId, sheetId);
    try {
      await expectIsolated(schools, {
        create: async (schoolId) => {
          const [row] = await rows(schoolId);
          if (!row) throw new Error('the sheet has no row');
          return row.id;
        },
        read: async (schoolId, id) => (await rows(schoolId)).find((r) => r.id === id) ?? null,
        list: rows,
        write: (schoolId, id) =>
          repo.updateDecision(schoolId, id, {
            resultId: null,
            proposed: null,
            decision: 'not_continuing',
            reason: 'Moving to another city',
            targetClassId: null,
            targetSectionId: null,
            decidedBy: f.userId,
            decidedAt: new Date(),
          }),
        snapshot: (row) => (row as { decision: string | null } | null)?.decision ?? null,
      });
      // The wave P review fixes' batch forms: another school marks, cancels and locks nothing.
      const [row] = await rows(schools.a.id);
      if (!row) throw new Error('the sheet has no row');
      expect(await repo.markDecisionsApplied(schools.b.id, [{ id: row.id, newEnrolmentId: null }], new Date())).toBe(0);
      expect((await rows(schools.a.id))[0]?.appliedAt).toBeNull();
      expect(await repo.lockResults(schools.b.id, sheetId)).toEqual([]);
      expect(await repo.markCancelled(schools.b.id, sheetId)).toBe(0);
      expect((await repo.findById(schools.a.id, all, sheetId))?.status).toBe('open');
    } finally {
      await close();
    }
  });
});
