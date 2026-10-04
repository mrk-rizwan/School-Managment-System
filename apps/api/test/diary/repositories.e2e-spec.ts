// Control 4 / R62 through the slice-13 repositories (contracts/slice-13.md §10 item 7): a diary
// entry or remark written as school A is invisible to, and unwritable by, school B, through the
// methods the services call. Reads use a school-wide scope (a principal's), and the capacity
// scope of school A's own guardian, so only the tenant key keeps rows apart.
import { Test } from '@nestjs/testing';
import { Capability } from '@asms/shared';
import { EnvModule } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { DiaryEntryRepository } from '../../src/repositories/diary-entry.repository';
import { RemarkRepository } from '../../src/repositories/remark.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import type { Scope } from '../../src/tenancy/scope';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, createTwoSchools, testDb, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createGuardian,
  createStudent,
  createSubject,
  day,
  enrol,
  linkGuardian,
} from '../support/students';
import { guardianLogin } from './support';

describe('diary and remark repositories: tenant isolation', () => {
  let close: () => Promise<void>;
  let entries: DiaryEntryRepository;
  let remarks: RemarkRepository;
  let permissions: PermissionsService;
  let all: Scope;
  const db = testDb();
  const page = { descending: true, skip: 0, take: 50 };
  const asSchool = (schoolId: SchoolId): TestSchool => ({ id: schoolId, shortCode: '' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule, AccessModule],
      providers: [DiaryEntryRepository, RemarkRepository],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    entries = moduleRef.get(DiaryEntryRepository);
    remarks = moduleRef.get(RemarkRepository);
    permissions = moduleRef.get(PermissionsService);
    const school = await createSchool();
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    const access = await permissions.load(school.id, principal.userId);
    const scope = access && (await permissions.can(school.id, access, Capability.DIARY_WRITE));
    if (!scope || scope.kind !== 'all') throw new Error('expected a school-wide scope');
    all = scope;
  });

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  /** A section with a teacher, a subject and a child whose guardian has a login. */
  async function classroom(schoolId: SchoolId) {
    const school = asSchool(schoolId);
    const { section } = await createClassWithSection(db, school);
    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const subject = await createSubject(db, school);
    const student = await createStudent(db, school);
    const enrolment = await enrol(db, school, student, section, { startedOn: '2026-09-01' });
    const guardian = await createGuardian(db, school);
    await linkGuardian(db, school, student, guardian, { canLogin: true });
    const login = await guardianLogin(db, school, guardian);
    const access = await permissions.load(schoolId, login.userId);
    if (!access) throw new Error('missing guardian access');
    const { scope: capacity } = await permissions.guardianChildren(schoolId, access);
    return { section, teacher, subject, student, enrolment, guardian, capacity };
  }

  it('diary_entries: every repository read and the lock see only their own school', async () => {
    const schools = await createTwoSchools();
    let roomA: Awaited<ReturnType<typeof classroom>> | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        roomA ??= room;
        const row = await entries.create(schoolId, {
          sectionId: room.section.id,
          classId: room.section.classId,
          academicYearId: room.section.academicYearId,
          date: day('2026-09-02'),
          subjectId: room.subject.id,
          authorStaffId: room.teacher.staffId,
          topic: 'Fractions',
          assignment: null,
          learningOutcome: null,
          dueOn: null,
          attachment: null,
        });
        return row.id;
      },
      read: (schoolId, id) => entries.findById(schoolId, all, id),
      list: async (schoolId) =>
        roomA ? (await entries.listForSection(schoolId, all, roomA.section.id, page)).rows : [],
      write: async (schoolId, id) => {
        const row = await entries.findById(schools.a.id, all, id);
        return row && (await entries.lockIfUnchanged(schoolId, row)) ? 1 : 0;
      },
      snapshot: (row) => (row as { updatedAt: Date } | null)?.updatedAt.toISOString(),
    });
    if (!roomA) throw new Error('missing');
    const a = roomA;
    const key = { sectionId: a.section.id, date: day('2026-09-02'), subjectId: a.subject.id };
    expect(await entries.findByNaturalKey(schools.a.id, key)).not.toBeNull();
    expect(await entries.findByNaturalKey(schools.b.id, key)).toBeNull();
    // The guardian's own read finds it in A and nothing as B.
    expect((await entries.listVisibleToStudent(schools.a.id, a.capacity, a.student.id, page)).total).toBe(1);
    expect((await entries.listVisibleToStudent(schools.b.id, a.capacity, a.student.id, page)).total).toBe(0);
    expect(
      await entries.postedRecipients(schools.b.id, { sectionId: a.section.id, date: day('2026-09-02') }, true),
    ).toEqual({ guardianIds: [], studentIds: [] });
    expect(
      (await entries.postedRecipients(schools.a.id, { sectionId: a.section.id, date: day('2026-09-02') }, true))
        .guardianIds,
    ).toEqual([a.guardian.id]);
  });

  it('remarks: every repository read and the lock see only their own school', async () => {
    const schools = await createTwoSchools();
    let roomA: Awaited<ReturnType<typeof classroom>> | undefined;
    await expectIsolated(schools, {
      create: async (schoolId) => {
        const room = await classroom(schoolId);
        roomA ??= room;
        const row = await remarks.create(schoolId, {
          enrolmentId: room.enrolment.id,
          studentId: room.student.id,
          authorStaffId: room.teacher.staffId,
          subjectId: null,
          date: day('2026-09-02'),
          category: 'homework',
          text: 'Homework not done.',
          visibility: 'guardian',
          supersedesId: null,
          correctionReason: null,
        });
        return row.id;
      },
      read: (schoolId, id) => remarks.findById(schoolId, all, id),
      list: async (schoolId) =>
        roomA
          ? (
              await remarks.listForStudent(schoolId, all, roomA.student.id, {
                ...page,
                includeSuperseded: true,
              })
            ).rows
          : [],
      write: async (schoolId, id) => ((await remarks.lockIfNotSuperseded(schoolId, id)) ? 1 : 0),
      snapshot: (row) => (row as { supersededAt: Date | null } | null)?.supersededAt,
    });
    if (!roomA) throw new Error('missing');
    expect(await remarks.guardianRecipients(schools.b.id, roomA.student.id)).toEqual([]);
    expect(await remarks.guardianRecipients(schools.a.id, roomA.student.id)).toEqual([roomA.guardian.id]);
  });
});
