// Control 4 / R62 for the slice 3 tables and Phase 4's set-up tables (slice 29): a row written as
// school A is invisible to, and unwritable by, school B, through the repositories the services use.
import type { SchoolId } from '../../src/tenancy/school-id';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
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

  // ---- Phase 4 slice 29 (phase-4-academic.md §3.2): the four set-up tables.

  /** A year seeded as the year-creation transaction seeds it (asms_seed_year_results). */
  const seededYear = async (schoolId: SchoolId) => {
    const year = await newYear(schoolId);
    await academics.yearRepo.seedResults(schoolId, year.id);
    return year;
  };
  const termPage = { skip: 0, take: 50, descending: false };

  it('academic_terms', async () => {
    const { termRepo } = academics;
    const years = new Map<bigint, bigint>();
    await expectIsolated(await createTwoSchools(), {
      create: async (schoolId) => {
        const year = await seededYear(schoolId);
        const [term] = (await termRepo.listForYear(schoolId, year.id, termPage)).rows;
        if (!term) throw new Error('no seeded term');
        years.set(term.id, year.id);
        return term.id;
      },
      read: (schoolId, id) => termRepo.findById(schoolId, id),
      list: async (schoolId) => {
        const rows = [];
        for (const yearId of years.values()) rows.push(...(await termRepo.listForYear(schoolId, yearId, termPage)).rows);
        return rows;
      },
      write: (schoolId, id) => termRepo.update(schoolId, id, { name: 'Taken over' }).then(() => 1),
      snapshot: nameOf,
    });
  });

  it('term_skips', async () => {
    const { termRepo } = academics;
    const schools = await createTwoSchools();
    const user = await createSchoolUser(testDb(), schools.a, { systemRole: 'principal' });
    const otherUser = await createSchoolUser(testDb(), schools.b, { systemRole: 'principal' });
    const year = await seededYear(schools.a.id);
    const klass = await academics.classRepo.create(schools.a.id, {
      academicYearId: year.id,
      name: `C ${tag()}`,
      sortOrder: 0,
      attendanceMode: 'daily',
    });
    const [term] = (await termRepo.listForYear(schools.a.id, year.id, termPage)).rows;
    if (!term) throw new Error('no seeded term');
    const skipOf = async (schoolId: SchoolId) => termRepo.findLiveSkip(schoolId, term.id, klass.id);
    await expectIsolated(schools, {
      create: async (schoolId) => {
        await termRepo.addSkip(schoolId, {
          academicYearId: year.id,
          termId: term.id,
          classId: klass.id,
          reason: 'Nursery has no mid-term',
          createdBy: user.userId,
        });
        const skip = await skipOf(schoolId);
        if (!skip) throw new Error('no skip');
        return skip.id;
      },
      read: (schoolId) => skipOf(schoolId),
      list: async (schoolId) => (await termRepo.findById(schoolId, term.id))?.skips ?? [],
      write: (schoolId, id) => termRepo.endSkip(schoolId, id, otherUser.userId),
      snapshot: (row) => (row as { id: bigint } | null)?.id ?? null,
    });
  });

  it('result_settings', async () => {
    const { settingsRepo } = academics;
    const schools = await createTwoSchools();
    const otherUser = await createSchoolUser(testDb(), schools.b, { systemRole: 'principal' });
    const year = await seededYear(schools.a.id);
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const row = await settingsRepo.findForYear(schoolId, year.id);
        if (!row) throw new Error('no seeded settings');
        return row.academicYearId;
      },
      read: (schoolId, yearId) => settingsRepo.findForYear(schoolId, yearId),
      write: (schoolId, yearId) =>
        settingsRepo.update(schoolId, yearId, { passPercent: 99 }, otherUser.userId).then(() => 1),
      snapshot: (row) => (row as { passPercent: number } | null)?.passPercent ?? null,
    });
  });

  it('class_subjects', async () => {
    const { classSubjectRepo } = academics;
    const schools = await createTwoSchools();
    const owner = await newClass(schools.a.id);
    const subject = await academics.subjectRepo.create(schools.a.id, { name: `S ${tag()}`, code: null });
    await expectIsolated(schools, {
      create: async (schoolId) => {
        await classSubjectRepo.create(schoolId, {
          academicYearId: owner.academicYearId,
          classId: owner.id,
          subjectId: subject.id,
          sortOrder: 1,
          examMaxMarks: 100,
        });
        const [row] = await classSubjectRepo.liveForClass(schoolId, owner.id);
        if (!row) throw new Error('no class subject');
        return row.id;
      },
      read: async (schoolId, id) => (await classSubjectRepo.liveForClass(schoolId, owner.id)).find((r) => r.id === id) ?? null,
      list: async (schoolId) => (await classSubjectRepo.listForClass(schoolId, owner.id, termPage)).rows,
      write: (schoolId, id) => classSubjectRepo.update(schoolId, id, { sortOrder: 9 }),
      snapshot: (row) => (row as { sortOrder: number } | null)?.sortOrder ?? null,
    });
  });

  it('refuses a term skip or class subject in school B naming school A’s rows (composite foreign keys)', async () => {
    const { a, b } = await createTwoSchools();
    const bUser = await createSchoolUser(testDb(), b, { systemRole: 'principal' });
    const year = await seededYear(a.id);
    const klass = await newClass(a.id);
    const [term] = (await academics.termRepo.listForYear(a.id, year.id, termPage)).rows;
    if (!term) throw new Error('no seeded term');
    await expect(
      academics.termRepo.addSkip(b.id, {
        academicYearId: year.id,
        termId: term.id,
        classId: klass.id,
        reason: 'Foreign',
        createdBy: bUser.userId,
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    const subject = await academics.subjectRepo.create(a.id, { name: `S ${tag()}`, code: null });
    await expect(
      academics.classSubjectRepo.create(b.id, {
        academicYearId: klass.academicYearId,
        classId: klass.id,
        subjectId: subject.id,
        sortOrder: 0,
        examMaxMarks: 100,
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
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
