// Control 4 / R62 for the wave U tables (migration 20261016120000_wave_u_rankings_imports_support),
// at the database through the guarded client: a row written as school A is invisible to, and
// unwritable by, school B. Slices 42, 43 and 45 add the same checks through their repositories
// when they write them; these hold the line until then and stay as the table-level floor. The
// append-only class_ranking_rows has no write probe: nothing updates it. platform_support_sessions
// is non-tenant (it names the school it is open on, like platform_audit_log): the probe reads it
// by that school, as the school's own screen will.
import type { SchoolId } from '../../src/tenancy/school-id';
import { createMarksFixture } from '../academics/assessment-fixture';
import { createResult, createSheet, moveSheet } from '../results/fixture';
import { expectIsolated } from '../support/isolation';
import { createPlatformUser } from '../support/platform';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';
import { createAcademicYear, day } from '../support/students';

const db = () => testDb();

describe('wave U tenant isolation (database level)', () => {
  let schools: TwoSchools;
  let n = 0;

  beforeAll(async () => {
    schools = await createTwoSchools();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  /** A school's class ranking of the Mid-term with one row: a published result of its student. */
  const ranked = async (schoolId: SchoolId) => {
    const f = await createMarksFixture({ id: schoolId, shortCode: '' });
    const sheetId = (await createSheet(f)).id;
    await moveSheet(f, sheetId, 'approved');
    const resultId = (await createResult(f, sheetId)).id;
    const publishedAt = new Date();
    await db().resultSheet.updateMany({ where: { schoolId, id: sheetId }, data: { status: 'published', publishedBy: f.userId, publishedAt } });
    await db().result.updateMany({ where: { schoolId, id: resultId }, data: { publishedAt } });
    const ranking = await db().classRanking.create({
      data: { schoolId, classId: f.classId, academicYearId: f.yearId, termId: f.midTermId, trigger: 'publish' },
    });
    const row = await db().classRankingRow.create({
      data: { schoolId, rankingId: ranking.id, resultId, studentId: f.studentId, enrolmentId: f.enrolmentId, classPosition: 1, positionOf: 1 },
    });
    return { ranking, row };
  };

  it('class_rankings: a school never reads, lists or supersedes another school ranking', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => (await ranked(schoolId)).ranking.id,
      read: (schoolId, id) => db().classRanking.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().classRanking.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) => (await db().classRanking.updateMany({ where: { schoolId, id }, data: { supersededAt: new Date() } })).count,
      snapshot: (row) => (row as { supersededAt: Date | null }).supersededAt,
    });
  });

  it('class_ranking_rows: a school never reads or lists another school ranking row', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => (await ranked(schoolId)).row.id,
      read: (schoolId, id) => db().classRankingRow.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().classRankingRow.findMany({ where: { schoolId }, select: { id: true } }),
    });
  });

  it('imports: a school never reads, lists or fails another school import', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const school = { id: schoolId, shortCode: '' };
        const office = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
        const year = await createAcademicYear(db(), school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
        return (
          await db().import.create({
            data: {
              schoolId,
              kind: 'opening_balances',
              fileHash: (++n).toString(16).padStart(64, 'a'),
              fileName: 'balances.csv',
              rowCount: 1,
              rows: [{ admissionNo: 'A-1', amount: 1500 }],
              academicYearId: year.id,
              dueOn: day('2026-10-10'),
              createdBy: office.userId,
            },
          })
        ).id;
      },
      read: (schoolId, id) => db().import.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().import.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (await db().import.updateMany({ where: { schoolId, id }, data: { status: 'failed', failedAt: new Date(), error: 'Taken' } })).count,
      snapshot: (row) => (row as { status: string }).status,
    });
  });

  it('platform_support_sessions: a school never reads, lists or revokes a session open on another school', async () => {
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (
          await db().platformSupportSession.create({
            data: {
              platformUserId: (await createPlatformUser()).id,
              schoolId,
              reason: 'Fee report looks wrong',
              ticketRef: 'TCK-7',
              expiresAt: new Date(Date.now() + 3_600_000),
            },
          })
        ).id,
      read: (schoolId, id) => db().platformSupportSession.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().platformSupportSession.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (
          await db().platformSupportSession.updateMany({
            where: { schoolId, id },
            data: { closedAt: new Date(), endKind: 'closed' },
          })
        ).count,
      snapshot: (row) => (row as { closedAt: Date | null }).closedAt,
    });
  });
});
