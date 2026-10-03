// Control 4 / R62 for holidays: HolidayRepository (contracts/slice-10.md §4), every read and
// write path, asked as another school. The composite publisher FK is checked at the database.
import { NestExpressApplication } from '@nestjs/platform-express';
import { HolidayRepository } from '../../src/repositories/holiday.repository';
import { createTestApp } from '../core/app';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createGuardian, createStudent, linkGuardian } from '../support/students';

const db = () => testDb();
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('Phase 2 calendar tenant isolation', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('holidays: a holiday written for school A is invisible to and unwritable by school B', async () => {
    const repo = app.get(HolidayRepository);
    const schools = await createTwoSchools();
    const { a, b } = schools;
    const principalA = await createSchoolUser(db(), a, { systemRole: 'principal' });
    const principalB = await createSchoolUser(db(), b, { systemRole: 'principal' });
    const range = { from: day('2026-12-25'), to: day('2026-12-25') };
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (
          await repo.create(schoolId, {
            startsOn: range.from,
            endsOn: range.to,
            name: 'Quaid Day',
            description: null,
            kind: 'public',
            appliesToStaff: true,
          })
        ).id,
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: async (schoolId) =>
        (
          await repo.list(schoolId, {
            statuses: ['draft', 'published', 'cancelled'],
            sort: 'startsOn',
            skip: 0,
            take: 50,
          })
        ).rows,
      write: async (schoolId, id) => {
        await repo.update(schoolId, id, { name: 'Taken over' });
        return 1;
      },
      snapshot: (row) => (row as { name: string } | null)?.name,
    });

    const [own] = (
      await repo.list(a.id, { statuses: ['draft'], sort: 'startsOn', skip: 0, take: 1 })
    ).rows;
    if (!own) throw new Error('missing');
    expect(await repo.lockIfUnchanged(b.id, own)).toBe(false);
    await expect(repo.publish(b.id, own.id, principalB.userId, new Date())).rejects.toThrow();
    await expect(repo.cancel(b.id, own.id, principalB.userId, new Date(), 'No')).rejects.toThrow();
    expect(await repo.firstLiveOverlapping(b.id, range.from, range.to)).toBeNull();
    expect(await repo.firstLiveOverlapping(a.id, range.from, range.to)).toBe(own.id);

    // Published rows feed only their own school's calendar.
    await repo.publish(a.id, own.id, principalA.userId, new Date());
    expect((await repo.publishedOverlapping(a.id, range.from, range.to)).map((x) => x.id)).toEqual([own.id]);
    expect(await repo.publishedOverlapping(b.id, range.from, range.to)).toEqual([]);

    // Notice recipients are the school's own people.
    const guardianA = await createGuardian(db(), a);
    await linkGuardian(db(), a, await createStudent(db(), a), guardianA);
    const recipientsB = await repo.noticeRecipients(b.id, true);
    expect(recipientsB.guardianIds).not.toContain(guardianA.id);
    expect(recipientsB.staffIds).not.toContain(principalA.staffId);
    expect((await repo.noticeRecipients(a.id, true)).guardianIds).toContain(guardianA.id);

    // The same dates in another school are that school's own holiday (the exclusion is per school).
    await expect(
      repo.create(b.id, {
        startsOn: range.from,
        endsOn: range.to,
        name: 'Quaid Day',
        description: null,
        kind: 'public',
        appliesToStaff: true,
      }),
    ).resolves.toBeDefined();

    // School B cannot record school A's user as the publisher.
    await expect(
      db().holiday.create({
        data: {
          schoolId: b.id,
          startsOn: day('2027-01-01'),
          endsOn: day('2027-01-01'),
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
