// Control 4 / R62 for the slice 3 tables: a row written as school A is invisible to, and
// unwritable by, school B, through the repositories the services use.
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated } from '../support/isolation';
import { closeTestDb, createTwoSchools } from '../support/schools';
import { createAcademics, tag, type Academics } from './support';

describe('academic structure tenant isolation', () => {
  let academics: Academics;

  beforeAll(async () => {
    academics = await createAcademics();
  });

  afterAll(async () => {
    await academics.close();
    await closeTestDb();
  });

  const newYear = (schoolId: SchoolId) =>
    academics.yearRepo.create(schoolId, {
      name: `Y ${tag()}`,
      startsOn: new Date('2026-04-01T00:00:00Z'),
      endsOn: new Date('2027-03-31T00:00:00Z'),
    });

  const newClass = async (schoolId: SchoolId) =>
    academics.classRepo.create(schoolId, {
      academicYearId: (await newYear(schoolId)).id,
      name: `C ${tag()}`,
      sortOrder: 0,
      attendanceMode: 'daily',
    });

  const page = { skip: 0, take: 50 };
  const nameOf = (row: unknown) => (row as { name: string } | null)?.name;

  it('academic_years', async () => {
    const { yearRepo } = academics;
    await expectIsolated(await createTwoSchools(), {
      create: async (schoolId) => (await newYear(schoolId)).id,
      read: (schoolId, id) => yearRepo.findById(schoolId, id),
      list: async (schoolId) => (await yearRepo.list(schoolId, { sort: 'name', ...page })).rows,
      write: (schoolId, id) => yearRepo.update(schoolId, id, { name: 'Taken over' }).then(() => 1),
      snapshot: nameOf,
    });
  });

  it('classes', async () => {
    const { classRepo } = academics;
    await expectIsolated(await createTwoSchools(), {
      create: async (schoolId) => (await newClass(schoolId)).id,
      read: (schoolId, id) => classRepo.findById(schoolId, id),
      list: async (schoolId) => (await classRepo.list(schoolId, { sort: 'name', ...page })).rows,
      write: (schoolId, id) => classRepo.update(schoolId, id, { name: 'Taken over' }).then(() => 1),
      snapshot: nameOf,
    });
  });

  it('sections', async () => {
    const { sectionRepo } = academics;
    const schools = await createTwoSchools();
    const owner = await newClass(schools.a.id);
    await expectIsolated(schools, {
      create: async (schoolId) =>
        (await sectionRepo.create(schoolId, { classId: owner.id, name: 'A', capacity: null })).id,
      read: (schoolId, id) => sectionRepo.findById(schoolId, id),
      list: async (schoolId) =>
        (
          await sectionRepo.listForClass(schoolId, owner.id, {
            includeArchived: true,
            sort: 'name',
            ...page,
          })
        ).rows,
      write: (schoolId, id) => sectionRepo.archive(schoolId, id).then(() => 1),
      snapshot: (row) => (row as { deletedAt: Date | null } | null)?.deletedAt ?? null,
    });
  });

  it('subjects', async () => {
    const { subjectRepo } = academics;
    await expectIsolated(await createTwoSchools(), {
      create: async (schoolId) =>
        (await subjectRepo.create(schoolId, { name: `S ${tag()}`, code: null })).id,
      read: (schoolId, id) => subjectRepo.findById(schoolId, id),
      list: async (schoolId) =>
        (await subjectRepo.list(schoolId, { includeArchived: true, sort: 'name', ...page })).rows,
      write: (schoolId, id) =>
        subjectRepo.update(schoolId, id, { name: 'Taken over' }).then(() => 1),
      snapshot: nameOf,
    });
  });

  it('refuses a row in school B that names school A’s parent row (composite foreign keys)', async () => {
    const { a, b } = await createTwoSchools();
    const year = await newYear(a.id);
    await expect(
      academics.classRepo.create(b.id, {
        academicYearId: year.id,
        name: 'Foreign',
        sortOrder: 0,
        attendanceMode: 'daily',
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    const owner = await newClass(a.id);
    await expect(
      academics.sectionRepo.create(b.id, { classId: owner.id, name: 'X', capacity: null }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
