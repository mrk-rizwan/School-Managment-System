// Control 4 / R62 for holidays (groundwork migration 20261003184500_phase2_calendar_settings).
// No repository exists yet, so the probe drives the guarded client as the slice-10 repository
// will, filtering on school_id; slice 10 replaces it with its repository and keeps the title.
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';

const db = () => testDb();

describe('Phase 2 calendar tenant isolation', () => {
  afterAll(() => closeTestDb());

  it('holidays: a holiday written for school A is invisible to and unwritable by school B', async () => {
    const schools = await createTwoSchools();
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (
          await db().holiday.create({
            data: {
              schoolId,
              startsOn: new Date('2026-12-25T00:00:00Z'),
              endsOn: new Date('2026-12-25T00:00:00Z'),
              name: 'Quaid Day',
              kind: 'public',
            },
            select: { id: true },
          })
        ).id,
      read: (schoolId, id) => db().holiday.findFirst({ where: { schoolId, id } }),
      list: (schoolId) => db().holiday.findMany({ where: { schoolId }, select: { id: true } }),
      write: async (schoolId, id) =>
        (await db().holiday.updateMany({ where: { schoolId, id }, data: { name: 'Taken over' } }))
          .count,
      snapshot: (row) => (row as { name: string } | null)?.name,
    });

    // The same dates in another school are that school's own holiday (the exclusion is per school).
    await expect(
      db().holiday.create({
        data: {
          schoolId: schools.b.id,
          startsOn: new Date('2026-12-25T00:00:00Z'),
          endsOn: new Date('2026-12-25T00:00:00Z'),
          name: 'Quaid Day',
          kind: 'public',
        },
      }),
    ).resolves.toBeDefined();

    // School B cannot record school A's user as the publisher.
    const principalA = await createSchoolUser(db(), schools.a, { systemRole: 'principal' });
    await expect(
      db().holiday.create({
        data: {
          schoolId: schools.b.id,
          startsOn: new Date('2027-01-01T00:00:00Z'),
          endsOn: new Date('2027-01-01T00:00:00Z'),
          name: 'New Year',
          kind: 'school',
          status: 'published',
          publishedAt: new Date(),
          publishedBy: principalA.userId,
        },
      }),
    ).rejects.toThrow(/holidays_published_by_fkey/);
  });
});
