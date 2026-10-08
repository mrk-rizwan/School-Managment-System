// Control 4 / R62 for the slice 3 tables and Phase 4's set-up tables (slice 29): a row written as
// school A is invisible to, and unwritable by, school B, through the repositories the services use.
import type { SchoolId } from '../../src/tenancy/school-id';
import { marksRepositories } from '../assessments/support';
import { expectIsolated, sectionsMarksScope } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb } from '../support/schools';
import { createAssessment, createCertificate, createMark, createMarksFixture } from './assessment-fixture';
import { createAcademics, tag, type Academics } from './support';
import { certificateRepositoryAs } from '../certificates/support';

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

  // ---- Phase 4 wave N (phase-4-academic.md §3.2): assessments, marks, certificates. The wave N
  // repositories do not exist yet (the slice 30 and 34 build agents add them); until they do, the
  // probes go through the guarded client with the tenant predicate, and each build agent replaces
  // its table's probe with its repository's read, list and write methods.

  // Slice 30: through AssessmentRepository and MarkRepository, with a write scope reaching the
  // fixture's section and subject (the probe as school B uses the same scope: only the SchoolId
  // differs).
  const fixtureScope = async (f: Awaited<ReturnType<typeof createMarksFixture>>) => {
    const listed = await testDb().classSubject.findFirst({ where: { schoolId: f.school.id, id: f.classSubjectId } });
    return sectionsMarksScope(
      'write',
      new Date('2026-05-10T00:00:00Z'),
      new Map([[f.sectionId, { classTeacher: false, cover: false, subjectIds: [listed!.subjectId] }]]),
    );
  };

  it('assessments', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const scope = await fixtureScope(f);
    const repos = await marksRepositories();
    try {
      await expectIsolated(schools, {
        create: async () => (await createAssessment(f)).id,
        read: (schoolId, id) => repos.assessments.find(schoolId, scope, id),
        list: async (schoolId) =>
          (await repos.assessments.list(schoolId, scope, { includeVoided: true }, { skip: 0, take: 50, ascending: false })).rows,
        write: async (schoolId, id) => ((await repos.assessments.update(schoolId, scope, id, { name: 'Taken over' })) ? 1 : 0),
        snapshot: nameOf,
      });
    } finally {
      await repos.close();
    }
  });

  it('marks', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const assessment = await createAssessment(f);
    const scope = await fixtureScope(f);
    const repos = await marksRepositories();
    try {
      const target = await repos.assessments.find(f.school.id, scope, assessment.id);
      if (!target) throw new Error('fixture assessment not found');
      await expectIsolated(schools, {
        create: async () => (await createMark(f, assessment)).id,
        read: (schoolId, id) => repos.marks.find(schoolId, scope, id),
        list: (schoolId) => repos.marks.liveForAssessment(schoolId, scope, assessment.id),
        write: async (schoolId, id) => ((await repos.marks.supersede(schoolId, scope, target, id)) ? 1 : 0),
        snapshot: (row) => (row as { status: string } | null)?.status ?? null,
      });
    } finally {
      await repos.close();
    }
  });

  it('mark corrections (slice 32: pending rows, their reads and decision)', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    const assessment = await createAssessment(f);
    const scope = await fixtureScope(f);
    const repos = await marksRepositories();
    try {
      const target = await repos.assessments.find(f.school.id, scope, assessment.id);
      if (!target) throw new Error('fixture assessment not found');
      await expectIsolated(schools, {
        create: async (schoolId) => {
          const live = await createMark(f, assessment);
          const pending = await repos.marks.insertPending(schoolId, scope, target, {
            enrolmentId: f.enrolmentId,
            studentId: f.studentId,
            obtained: 5,
            absent: false,
            supersedesId: live.id,
            correctionReason: 'Re-totalled',
            enteredBy: f.userId,
          });
          return pending.id;
        },
        read: (schoolId, id) => repos.marks.findCorrection(schoolId, scope, id),
        list: async (schoolId) => (await repos.marks.listCorrections(schoolId, scope, {}, { skip: 0, take: 50 })).rows,
        write: async (schoolId, id) =>
          (await repos.marks.decide(schoolId, scope, target, id, { status: 'rejected', by: f.userId, at: new Date() })) ? 1 : 0,
        snapshot: (row) => (row as { state: string } | null)?.state ?? null,
      });
      expect(await repos.marks.pendingFor(schools.b.id, scope, assessment.id, f.enrolmentId)).toBeNull();
      expect(await repos.marks.pendingFor(schools.a.id, scope, assessment.id, f.enrolmentId)).not.toBeNull();
    } finally {
      await repos.close();
    }
  });

  it('certificates', async () => {
    const schools = await createTwoSchools();
    const f = await createMarksFixture(schools.a);
    // Slice 34: through CertificateRepository with a school-wide (principal's) scope, so only the
    // tenant key keeps the rows apart.
    const { repo, all, close } = await certificateRepositoryAs(schools.a, f.userId);
    try {
      let number = 0;
      const numbers = new Map<bigint, number>();
      await expectIsolated(schools, {
        create: async () => {
          const row = await createCertificate(f, ++number);
          numbers.set(row.id, number);
          return row.id;
        },
        read: (schoolId, id) => repo.findById(schoolId, all, id),
        list: async (schoolId) =>
          (await repo.list(schoolId, all, { studentId: f.studentId, descending: true, skip: 0, take: 50 })).rows,
        // A void stamps the certificate number (type and number), never the id alone.
        write: async (schoolId, id) =>
          (await repo.voidNumber(schoolId, 'character', numbers.get(id) ?? 0, f.userId, 'Taken over', new Date())).length,
        snapshot: (row) => (row as { voidedAt: Date | null } | null)?.voidedAt ?? null,
      });
    } finally {
      await close();
    }
  });

  it('refuses an assessment, mark or certificate in school B naming school A’s rows (composite foreign keys)', async () => {
    const { a, b } = await createTwoSchools();
    const f = await createMarksFixture(a);
    const bUser = await createSchoolUser(testDb(), b, { systemRole: 'principal' });
    const assessment = await createAssessment(f);
    const original = await createCertificate(f, 1);
    const db = testDb();
    // School B's own term and year, school A's class, section and subject: the composite keys refuse it.
    const fB = await createMarksFixture(b);
    await expect(
      db.assessment.create({
        data: {
          schoolId: b.id,
          academicYearId: fB.yearId,
          termId: fB.midTermId,
          classId: f.classId,
          sectionId: f.sectionId,
          classSubjectId: f.classSubjectId,
          kind: 'test',
          testType: 'daily',
          name: 'Foreign',
          maxMarks: 10,
          heldOn: new Date('2026-05-10T00:00:00Z'),
          createdBy: bUser.userId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      db.mark.create({
        data: {
          schoolId: b.id,
          assessmentId: assessment.id,
          enrolmentId: f.enrolmentId,
          studentId: f.studentId,
          academicYearId: f.yearId,
          maxMarks: assessment.maxMarks,
          obtained: 5,
          status: 'live',
          enteredBy: bUser.userId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      db.certificate.create({
        data: {
          schoolId: b.id,
          studentId: f.studentId,
          type: 'other',
          number: 1,
          issueNo: 2,
          reissueOfId: original.id,
          title: 'Foreign',
          body: {},
          reason: 'Foreign',
          duesStatus: 'not_required',
          issuedBy: bUser.userId,
          issuedOn: new Date('2026-06-01T00:00:00Z'),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
