// Tenant isolation of the slice-4 repositories (CLAUDE.md control 4, R62): a row written as
// school A is invisible to, and unwritable by, school B. HTTP-level 404s are in the e2e suites.
import { NestExpressApplication } from '@nestjs/platform-express';
import { addDays, todayIn } from '../../src/common/school-clock';
import { StaffRepository } from '../../src/repositories/staff.repository';
import { TeacherAssignmentRepository } from '../../src/repositories/teacher-assignment.repository';
import { UserRoleRepository } from '../../src/repositories/user-role.repository';
import { createTestApp } from '../core/app';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createTeacherAssignment,
  day,
} from '../support/students';
import { SCHOOL_TZ } from './support';

describe('slice-4 repositories are tenant-isolated', () => {
  let app: NestExpressApplication;
  let schools: TwoSchools;
  const db = testDb();
  const today = todayIn(SCHOOL_TZ);

  beforeAll(async () => {
    app = await createTestApp();
    schools = await createTwoSchools();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('staff: read, list and every write', async () => {
    const repo = app.get(StaffRepository);
    const { a, b } = schools;
    await expectIsolated(schools, {
      create: async () => (await createSchoolUser(db, a, { systemRole: 'teacher' })).staffId,
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: async (schoolId) => (await repo.list(schoolId, { sort: 'fullName', skip: 0, take: 50 })).rows,
      write: async (schoolId, id) => {
        await repo.update(schoolId, id, { fullName: 'Hijacked' });
        return 1;
      },
      snapshot: (row) => (row as { fullName: string }).fullName,
    });
    const owned = await createSchoolUser(db, a, { systemRole: 'teacher' });
    const row = await repo.findById(a.id, owned.staffId);
    if (!row) throw new Error('missing');
    expect(await repo.lockIfUnchanged(b.id, row)).toBe(false);
    await expect(repo.setStatus(b.id, row.id, 'left', today)).rejects.toThrow();
    expect(await repo.findByCnicHash(b.id, row.cnicHash ?? '')).toBeNull();
    expect((await repo.findById(a.id, row.id))?.status).toBe('active');
  });

  it('teacher_assignments: read, every list path, scope and every write', async () => {
    const repo = app.get(TeacherAssignmentRepository);
    const { a, b } = schools;
    const teacher = await createSchoolUser(db, a, { systemRole: 'teacher' });
    const section = await createSection(db, a, await createClass(db, a, await createAcademicYear(db, a)));
    await expectIsolated(schools, {
      create: async () =>
        (await createTeacherAssignment(db, a, teacher, { role: 'class_teacher', section, startsOn: '2026-01-01' })).id,
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: (schoolId) => repo.findClassTeacherConflicts(schoolId, section.id, day('2000-01-01'), null),
      write: async (schoolId, id) => {
        await repo.setEndsOn(schoolId, id, addDays(today, 5));
        return 1;
      },
      snapshot: (row) => (row as { endsOn: Date | null }).endsOn,
    });
    // Every other read and write, as school B with school A's ids.
    const [row] = await repo.findNotEndedForStaff(a.id, teacher.staffId, today);
    if (!row) throw new Error('missing');
    expect(await repo.findNotEndedForStaff(b.id, teacher.staffId, today)).toEqual([]);
    const page = await repo.listForStaff(b.id, teacher.staffId, {
      includeEnded: true,
      today,
      sort: '-startsOn',
      skip: 0,
      take: 50,
    });
    expect(page).toEqual({ rows: [], total: 0 });
    expect(await repo.activeSectionIds(a.id, teacher.staffId, today)).toEqual([section.id]);
    expect(await repo.activeSectionIds(b.id, teacher.staffId, today)).toEqual([]);
    expect(await repo.existsNotEndedOnSection(b.id, section.id, today)).toBe(false);
    expect(await repo.lockIfUnchanged(b.id, row)).toBe(false);
    await expect(repo.void(b.id, row.id, teacher.userId, new Date())).rejects.toThrow();
    expect((await repo.findById(a.id, row.id))?.voidedAt).toBeNull();
  });

  it('user_roles: read, list and every write', async () => {
    const repo = app.get(UserRoleRepository);
    const { a, b } = schools;
    const user = await createSchoolUser(db, a, { systemRole: 'teacher' });
    const owners: bigint[] = [];
    await expectIsolated(schools, {
      create: async () => {
        const owner = await createSchoolUser(db, a, { systemRole: 'office_staff' });
        owners.push(owner.userId);
        return owner.userRoleId;
      },
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: async (schoolId) => {
        const rows = [];
        for (const userId of owners) {
          rows.push(...(await repo.listForUser(schoolId, userId, { includeEnded: true, skip: 0, take: 50 })).rows);
        }
        return rows;
      },
      write: (schoolId, id) => repo.end(schoolId, id, user.userId, new Date()),
      snapshot: (row) => (row as { endedAt: Date | null }).endedAt,
    });
    expect((await repo.liveRolesByUser(b.id, [user.userId])).size).toBe(0);
    expect(await repo.findLive(b.id, user.userId, { kind: 'system', systemRole: 'teacher' })).toBeNull();
    expect(await repo.endAllForUser(b.id, user.userId, user.userId, new Date())).toBe(0);
    expect(await repo.findLive(a.id, user.userId, { kind: 'system', systemRole: 'teacher' })).toMatchObject({ endedAt: null });
  });
});
