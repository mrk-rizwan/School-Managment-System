// phase-4-academic.md §0.27, §7.1 (groundwork for R263): the subject-aware MarksScope, minted only
// in src/tenancy/scope.mint.ts by PermissionsService.marksReadScopeOf / marksWriteScopeOf from
// teacher_assignments on one date. A read scope and a write scope are distinct types. The assessment and mark repositories that consume it arrive in wave N; their R263 tests
// (same section, other subject → 404) drive it end to end.
import { Capability } from '@asms/shared';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import type { MarksScope, SectionRoles } from '../../src/tenancy/scope';
import { sectionsMarksScope } from '../support/isolation';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createSubject,
  createTeacherAssignment,
  day,
  type TestClass,
} from '../support/students';
import { schoolDay, StaffHarness } from './support';

const byId = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

describe('MarksScope (phase 4 §0.27)', () => {
  const h = new StaffHarness();
  const db = h.db;
  let school: TestSchool;
  let klass: TestClass;
  let permissions: PermissionsService;

  const teacher = (): Promise<TestSchoolUser> => createSchoolUser(db, school, { systemRole: 'teacher' });
  const sessionOf = (user: TestSchoolUser, extra: Capability[] = []) => h.widenedSession(school, user.userId, extra);
  const on = (offset: number) => day(schoolDay(offset));

  beforeAll(async () => {
    await h.start();
    school = await createSchool();
    klass = await createClass(db, school, await createAcademicYear(db, school));
    permissions = h.app.get(PermissionsService);
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  it('a subject teacher holds their subjects per section; a class teacher and a cover are flagged; dates bound it', async () => {
    const sixA = await createSection(db, school, klass);
    const sixB = await createSection(db, school, klass);
    const maths = (await createSubject(db, school)).id;
    const english = (await createSubject(db, school)).id;
    const t = await teacher();
    await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId: maths, section: sixA });
    await createTeacherAssignment(db, school, t, { role: 'class_teacher', section: sixB });
    await createTeacherAssignment(db, school, t, {
      role: 'subject_teacher',
      subjectId: english,
      section: sixB,
      startsOn: schoolDay(1),
      endsOn: schoolDay(1),
    });
    const today = await permissions.marksWriteScopeOf(await sessionOf(t), on(0));
    expect(today?.kind).toBe('sections');
    const sections = today?.kind === 'sections' ? [...today.sections.entries()] : [];
    expect(sections).toEqual(
      [
        [sixA.id, { classTeacher: false, cover: false, subjectIds: [maths] }],
        [sixB.id, { classTeacher: true, cover: false, subjectIds: [] }],
      ].sort((x, y) => byId(x[0] as bigint, y[0] as bigint)),
    );
    expect(today?.on).toEqual(on(0));
    const tomorrow = await permissions.marksWriteScopeOf(await sessionOf(t), on(1));
    expect(tomorrow?.kind === 'sections' && tomorrow.sections.get(sixB.id)).toEqual({
      classTeacher: true,
      cover: false,
      subjectIds: [english],
    });
  });

  it('a cover carries the covered section for its dates only', async () => {
    const s = await createSection(db, school, klass);
    const t = await teacher();
    await createTeacherAssignment(db, school, t, { role: 'cover', section: s, startsOn: schoolDay(2), endsOn: schoolDay(2) });
    const during = await permissions.marksWriteScopeOf(await sessionOf(t), on(2));
    expect(during?.kind === 'sections' && during.sections.get(s.id)).toEqual({ classTeacher: false, cover: true, subjectIds: [] });
    const after = await permissions.marksWriteScopeOf(await sessionOf(t), on(3));
    expect(after?.kind === 'sections' && after.sections.size).toBe(0);
  });

  it('school-wide for the principal and an office grant of marks.enter; null without the capability or an active staff record', async () => {
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    expect(await permissions.marksWriteScopeOf(await sessionOf(principal), on(0))).toMatchObject({
      kind: 'all',
      on: on(0),
    });
    const office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    expect(await permissions.marksWriteScopeOf(await sessionOf(office), on(0))).toBeNull();
    expect(
      await permissions.marksWriteScopeOf(await sessionOf(office, [Capability.MARKS_ENTER]), on(0)),
    ).toMatchObject({ kind: 'all' });
    const idle = await teacher();
    const empty = await permissions.marksWriteScopeOf(await sessionOf(idle), on(0));
    expect(empty?.kind === 'sections' && empty.sections.size).toBe(0);
    // R59: a teacher whose staff record is not active holds nothing.
    const suspended = await createSchoolUser(db, school, { systemRole: 'teacher', staffStatus: 'suspended' });
    expect(await permissions.marksWriteScopeOf(await sessionOf(suspended), on(0))).toBeNull();
  });

  it('marks.view_all widens a teacher’s read to the school, never their write (security LOW-1)', async () => {
    const section = await createSection(db, school, klass);
    const maths = (await createSubject(db, school)).id;
    const t = await teacher();
    await createTeacherAssignment(db, school, t, { role: 'subject_teacher', subjectId: maths, section });
    const session = await sessionOf(t, [Capability.MARKS_VIEW_ALL]);
    const read = await permissions.marksReadScopeOf(session, on(0));
    expect(read).toMatchObject({ mode: 'read', kind: 'all', on: on(0) });
    const write = await permissions.marksWriteScopeOf(session, on(0));
    expect(write?.mode).toBe('write');
    expect(write?.kind === 'sections' && [...write.sections.entries()]).toEqual([
      [section.id, { classTeacher: false, cover: false, subjectIds: [maths] }],
    ]);
    // Without the grant, the teacher reads exactly what they write.
    const plain = await sessionOf(t);
    expect(await permissions.marksReadScopeOf(plain, on(0))).toMatchObject({ mode: 'read', kind: 'sections' });
    // view_all alone (no marks.enter) reads school-wide and writes nothing.
    const viewer = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const viewerSession = await sessionOf(viewer, [Capability.MARKS_VIEW_ALL]);
    expect(await permissions.marksReadScopeOf(viewerSession, on(0))).toMatchObject({ mode: 'read', kind: 'all' });
    expect(await permissions.marksWriteScopeOf(viewerSession, on(0))).toBeNull();
  });

  it('a read scope is not a write scope at compile time', () => {
    // If MarksScope<'read'> were assignable to MarksScope<'write'>, `readIsNotWrite` would have to
    // be false and this file would not compile (tsc runs over test/).
    type ReadIsNotWrite = MarksScope<'read'> extends MarksScope<'write'> ? false : true;
    type WriteIsAScope = MarksScope<'write'> extends MarksScope ? true : false;
    const readIsNotWrite: ReadIsNotWrite = true;
    const writeIsAScope: WriteIsAScope = true;
    expect([readIsNotWrite, writeIsAScope]).toEqual([true, true]);
    const readAny = (scope: MarksScope) => scope.mode;
    const read = sectionsMarksScope('read', new Date('2026-10-07T00:00:00Z'), new Map());
    const write = sectionsMarksScope('write', new Date('2026-10-07T00:00:00Z'), new Map());
    expect([readAny(read), readAny(write)]).toEqual(['read', 'write']);
  });

  it('the mint copies deeply: mutating the input afterwards cannot widen a scope', () => {
    const subjectIds = [1n];
    const input = new Map<bigint, SectionRoles>([[10n, { classTeacher: false, cover: false, subjectIds }]]);
    const scope = sectionsMarksScope('write', new Date('2026-10-07T00:00:00Z'), input);
    subjectIds.push(2n);
    input.set(11n, { classTeacher: true, cover: false, subjectIds: [] });
    expect(scope.kind === 'sections' && [...scope.sections.entries()]).toEqual([
      [10n, { classTeacher: false, cover: false, subjectIds: [1n] }],
    ]);
  });
});
