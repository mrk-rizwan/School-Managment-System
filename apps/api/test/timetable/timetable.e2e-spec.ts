// Slice 37 over HTTP (phase-5-extended.md R301-R309; contracts/slice-37.md): versions, voids,
// clashes, the assignment rule, the attendance tightening (R304), the unrecorded periods (R305),
// substitutions (R306), periods needing cover (R307), the family DTO (R308), the week across two
// versions (R309), the registers console's periods, the settings refusal and the grid. The real
// AppModule with fake messaging drivers (the slice-11 harness).
import request from 'supertest';
import { ErrorCode, newIdempotencyKey } from '@asms/shared';
import { addDays } from '../../src/common/school-clock';
import { mondayOf } from '../../src/modules/timetable/timetable.shared';
import { RegisterDeadlineSweep } from '../../src/modules/attendance/attendance-jobs';
import { AttendanceHarness, at, D, errorOf, fieldsOf, schoolDay, type Caller, type Child } from '../attendance/harness';
import { guardianLogin, studentLogin } from '../diary/support';
import { asSchool } from '../messaging/support';
import { closeTestDb, type TestSchool } from '../support/schools';
import { createSubject, createTeacherAssignment, type TestSection } from '../support/students';
import { ORIGIN } from '../staff/support';

const h = new AttendanceHarness();
const db = () => h.db;

interface Slot {
  id: string;
  weekday: number;
  period: number;
  classSubjectId: string;
  subjectName: string;
  staffId: string;
  teacherName: string;
  room: string | null;
  assignedTeacher: boolean;
}
interface Version {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
  slotCount: number;
  voidReason: string | null;
  slots: Slot[];
}
interface Substitution {
  id: string;
  date: string;
  period: number;
  staffId: string;
  teacherName: string;
  regularStaffId: string | null;
  subjectName: string | null;
  reason: string;
  voidedAt: string | null;
}

/** The weekday (0 = Sunday) of a 'YYYY-MM-DD'. */
const weekdayOf = (iso: string): number => D(iso).getUTCDay();

interface World {
  school: TestSchool;
  principal: Caller;
  /** Maths in A. */
  t1: Caller;
  /** English in A and B. */
  t2: Caller;
  /** Maths in B. */
  t3: Caller;
  /** A's class teacher. */
  ct: Caller;
  a: TestSection;
  b: TestSection;
  maths: string;
  english: string;
  yearId: bigint;
  child: Child;
}

describe('slice 37: the period timetable (e2e)', () => {
  beforeAll(() => h.start());
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });
  afterEach(() => h.restoreClock());

  const keyed = (path: string, body: object, c: Caller, key = newIdempotencyKey()) =>
    request(h.app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Cookie', c.cookie)
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', key)
      .send(body);

  /** A period-mode class with sections A and B, two subjects and four teachers, a child in A. */
  const world = async (): Promise<World> => {
    const school = await h.school({ periodsPerDay: 8 });
    const principal = await h.caller(school, 'principal', 'Nadia Principal');
    const t1 = await h.caller(school, 'teacher', 'Tariq Maths');
    const t2 = await h.caller(school, 'teacher', 'Erum English');
    const t3 = await h.caller(school, 'teacher', 'Bilal Maths');
    const ct = await h.caller(school, 'teacher', 'Cara Class');
    const a = await h.section(school, { mode: 'period', className: 'Class 5', sectionName: 'A' });
    const klass = { id: a.classId, academicYearId: a.academicYearId };
    const b = await (async () => {
      const row = await db().section.create({ data: { schoolId: school.id, classId: a.classId, name: 'B' } });
      return { id: row.id, schoolId: school.id, classId: a.classId, academicYearId: a.academicYearId };
    })();
    const subject = async (name: string) => {
      const s = await createSubject(db(), school, { name });
      const cs = await db().classSubject.create({
        data: { schoolId: school.id, academicYearId: a.academicYearId, classId: a.classId, subjectId: s.id, sortOrder: 1 },
      });
      return { subjectId: s.id, classSubjectId: cs.id.toString() };
    };
    const maths = await subject('Mathematics');
    const english = await subject('English');
    const from = schoolDay(-30);
    await createTeacherAssignment(db(), school, t1, { role: 'subject_teacher', subjectId: maths.subjectId, section: a, startsOn: from });
    await createTeacherAssignment(db(), school, t2, { role: 'subject_teacher', subjectId: english.subjectId, klass, startsOn: from });
    await createTeacherAssignment(db(), school, t3, { role: 'subject_teacher', subjectId: maths.subjectId, section: b, startsOn: from });
    await createTeacherAssignment(db(), school, ct, { role: 'class_teacher', section: a, startsOn: from });
    const child = await h.child(school, a, { fullName: 'Ayesha Khan', canLogin: true });
    return {
      school,
      principal,
      t1,
      t2,
      t3,
      ct,
      a,
      b,
      maths: maths.classSubjectId,
      english: english.classSubjectId,
      yearId: a.academicYearId,
      child,
    };
  };

  const create = (w: World, section: TestSection, effectiveFrom: string, slots: object[], key?: string) =>
    keyed(`/sections/${section.id}/timetable-versions`, { effectiveFrom, slots }, w.principal, key);
  /** A version that started before today, written directly (the API refuses a past start). */
  const pastVersion = async (
    w: World,
    section: TestSection,
    from: string,
    slots: { classSubjectId: string; staff: Caller; weekday: number; period: number }[] = [],
  ): Promise<string> => {
    const v = await db().timetableVersion.create({
      data: {
        schoolId: w.school.id,
        sectionId: section.id,
        classId: section.classId,
        academicYearId: section.academicYearId,
        effectiveFrom: D(from),
        createdBy: w.principal.userId,
      },
    });
    for (const s of slots) {
      await db().timetableSlot.create({
        data: {
          schoolId: w.school.id,
          versionId: v.id,
          classId: section.classId,
          weekday: s.weekday,
          period: s.period,
          classSubjectId: BigInt(s.classSubjectId),
          staffId: s.staff.staffId,
          effectiveFrom: D(from),
        },
      });
    }
    return v.id.toString();
  };
  const slotOf = (classSubjectId: string, staff: Caller, weekday: number, period: number, room?: string) => ({
    weekday,
    period,
    classSubjectId,
    staffId: staff.staffId.toString(),
    ...(room === undefined ? {} : { room }),
  });
  const audits = (w: World, action: string) => db().auditLog.findMany({ where: { schoolId: w.school.id, action } });

  // ---------------------------------------------------------------------------- R301

  it('R301: a version from today, superseded by a later one (closed the day before); replay 200; the refusals', async () => {
    const w = await world();
    const T = schoolDay();
    const key = newIdempotencyKey();
    const first = await create(w, w.a, T, [slotOf(w.maths, w.t1, weekdayOf(T), 1, 'Room 5')], key);
    expect(first.status).toBe(201);
    const v1 = first.body as Version;
    expect(v1).toMatchObject({ effectiveFrom: T, effectiveTo: null, status: 'live', slotCount: 1 });
    expect(v1.slots[0]).toMatchObject({ subjectName: 'Mathematics', teacherName: 'Tariq Maths', room: 'Room 5', assignedTeacher: true });
    const replay = await create(w, w.a, T, [slotOf(w.maths, w.t1, weekdayOf(T), 1, 'Room 5')], key);
    expect([replay.status, replay.headers['idempotency-replayed'], (replay.body as Version).id]).toEqual([200, 'true', v1.id]);

    const second = await create(w, w.a, schoolDay(7), [slotOf(w.maths, w.t1, weekdayOf(T), 2)]);
    expect(second.status).toBe(201);
    const v1After = (await h.get(`/timetable-versions/${v1.id}`, w.principal.cookie)).body as Version;
    expect([v1After.effectiveTo, v1After.status]).toEqual([schoolDay(6), 'live']);
    expect((second.body as Version).status).toBe('future');
    const [audit] = await audits(w, 'timetable_version.created').then((rows) => rows.filter((r) => r.subjectId === BigInt((second.body as Version).id)));
    expect(audit?.metadata).toMatchObject({ supersededVersionId: v1.id, slots: 1 });

    const between = await create(w, w.a, schoolDay(3), [slotOf(w.maths, w.t1, 1, 1)]);
    expect([between.status, errorOf(between).code, errorOf(between).details]).toEqual([
      409,
      ErrorCode.TIMETABLE_VERSION_SUPERSEDED,
      { versionId: (second.body as Version).id },
    ]);
    const past = await create(w, w.a, schoolDay(-1), [slotOf(w.maths, w.t1, 1, 1)]);
    expect([past.status, fieldsOf(past)[0]?.path]).toEqual([422, 'effectiveFrom']);
    const outside = await create(w, w.a, schoolDay(200), [slotOf(w.maths, w.t1, 1, 1)]);
    expect([outside.status, fieldsOf(outside)[0]?.path]).toEqual([422, 'effectiveFrom']);
    const both = await keyed(`/sections/${w.a.id}/timetable-versions`, { effectiveFrom: schoolDay(20), slots: [slotOf(w.maths, w.t1, 1, 1)], copyFromVersionId: v1.id }, w.principal);
    expect([both.status, fieldsOf(both)[0]?.path]).toEqual([422, 'slots']);
    const copy = await keyed(`/sections/${w.a.id}/timetable-versions`, { effectiveFrom: schoolDay(20), copyFromVersionId: v1.id }, w.principal);
    expect([copy.status, (copy.body as Version).slots.map((s) => [s.weekday, s.period, s.room])]).toEqual([201, [[weekdayOf(T), 1, 'Room 5']]]);

    const live = (await h.get(`/timetable-versions?sectionId=${w.a.id}&status=live`, w.principal.cookie)).body as { data: Version[] };
    expect(live.data.map((v) => v.id)).toEqual([v1.id]);
    const future = (await h.get(`/timetable-versions?sectionId=${w.a.id}&status=future&sort=effectiveFrom`, w.principal.cookie)).body as { data: Version[] };
    expect(future.data.map((v) => v.effectiveFrom)).toEqual([schoolDay(7), schoolDay(20)]);
    // Teachers read any section's week, never the manager's routes.
    expect((await h.get(`/timetable-versions`, w.t1.cookie)).status).toBe(403);
    expect((await create({ ...w, principal: w.t1 }, w.a, schoolDay(30), [slotOf(w.maths, w.t1, 1, 1)])).status).toBe(403);
  });

  it('R301: void a future version restores its predecessor and re-checks clashes; a live one is not voidable; a repeat is 200', async () => {
    const w = await world();
    const T = schoolDay();
    const wd = weekdayOf(schoolDay(10));
    const v1 = (await create(w, w.a, T, [slotOf(w.english, w.t2, wd, 3)])).body as Version;
    const v2 = (await create(w, w.a, schoolDay(7), [slotOf(w.maths, w.t1, wd, 3)])).body as Version;
    // From day 7 teacher 2 is free at that weekday-period, so section B takes them.
    const vb = await create(w, w.b, schoolDay(7), [slotOf(w.english, w.t2, wd, 3)]);
    expect(vb.status).toBe(201);
    const clash = await h.post(`/timetable-versions/${v2.id}/void`, { reason: 'Entered by mistake' }, w.principal.cookie);
    expect([clash.status, errorOf(clash).code, errorOf(clash).details]).toMatchObject([
      409,
      ErrorCode.TIMETABLE_SLOT_CLASH,
      { kind: 'teacher', weekday: wd, period: 3, conflictingSlotId: (vb.body as Version).slots[0]!.id },
    ]);
    expect((await h.post(`/timetable-versions/${(vb.body as Version).id}/void`, { reason: 'Not needed' }, w.principal.cookie)).status).toBe(200);
    const voided = await h.post(`/timetable-versions/${v2.id}/void`, { reason: 'Entered by mistake' }, w.principal.cookie);
    expect([voided.status, (voided.body as Version).status, (voided.body as Version).voidReason]).toEqual([200, 'voided', 'Entered by mistake']);
    const restored = (await h.get(`/timetable-versions/${v1.id}`, w.principal.cookie)).body as Version;
    expect([restored.effectiveTo, restored.status]).toEqual([null, 'live']);
    expect((await audits(w, 'timetable_version.voided')).map((r) => r.metadata)).toContainEqual(
      expect.objectContaining({ restoredVersionId: v1.id }),
    );
    const again = await h.post(`/timetable-versions/${v2.id}/void`, { reason: 'Again' }, w.principal.cookie);
    expect([again.status, (again.body as Version).voidReason]).toEqual([200, 'Entered by mistake']);
    expect((await audits(w, 'timetable_version.voided')).filter((r) => r.subjectId === BigInt(v2.id))).toHaveLength(1);
    // A version that started before today is history: not voidable.
    const started = await pastVersion(w, w.b, schoolDay(-3));
    const liveVoid = await h.post(`/timetable-versions/${started}/void`, { reason: 'Too late' }, w.principal.cookie);
    expect([liveVoid.status, errorOf(liveVoid).code]).toEqual([409, ErrorCode.TIMETABLE_VERSION_NOT_FUTURE]);
  });

  it('R301 (wave R review): a version starting today can be voided the same day, restoring the one before it', async () => {
    const w = await world();
    const T = schoolDay();
    const old = await pastVersion(w, w.a, schoolDay(-5), [{ classSubjectId: w.maths, staff: w.t1, weekday: 1, period: 1 }]);
    const today = await create(w, w.a, T, [slotOf(w.maths, w.t1, 2, 1)]);
    expect(today.status).toBe(201);
    expect((await db().timetableVersion.findFirst({ where: { schoolId: w.school.id, id: BigInt(old) } }))?.effectiveTo).toEqual(D(schoolDay(-1)));
    // Redoing today needs the day's version voided first; the refusal does not call it "later".
    const redo = await create(w, w.a, T, [slotOf(w.maths, w.t1, 3, 1)]);
    expect([redo.status, errorOf(redo).code, errorOf(redo).message]).toEqual([
      409,
      ErrorCode.TIMETABLE_VERSION_SUPERSEDED,
      'This section already has a timetable starting on that date or after it. Void it first.',
    ]);
    const voided = await h.post(`/timetable-versions/${(today.body as Version).id}/void`, { reason: 'Wrong lessons' }, w.principal.cookie);
    expect([voided.status, (voided.body as Version).status]).toEqual([200, 'voided']);
    const restored = (await h.get(`/timetable-versions/${old}`, w.principal.cookie)).body as Version;
    expect([restored.effectiveTo, restored.status]).toEqual([null, 'live']);
    expect((await create(w, w.a, T, [slotOf(w.maths, w.t1, 3, 1)])).status).toBe(201);
  });

  it('wave R review: a version change that would orphan a live substitution is refused until it is voided', async () => {
    const w = await world();
    const T = schoolDay();
    const d2 = schoolDay(2);
    const d5 = schoolDay(5);
    const slots = [slotOf(w.maths, w.t1, weekdayOf(d2), 2), slotOf(w.maths, w.t1, weekdayOf(d5), 3)];
    await create(w, w.a, T, slots.slice(0, 1));
    const sub = await keyed(`/sections/${w.a.id}/timetable-substitutions`, { date: d2, period: 2, staffId: w.t2.staffId.toString(), reason: 'Tariq at a workshop' }, w.principal);
    expect(sub.status).toBe(201);
    const subId = (sub.body as Substitution).id;
    // Create: a new version from day 1 would replace the substituted slot of day 2.
    const blocked = await create(w, w.a, schoolDay(1), slots);
    expect([blocked.status, errorOf(blocked).code, errorOf(blocked).details]).toEqual([
      409,
      ErrorCode.TIMETABLE_SUBSTITUTIONS_EXIST,
      { substitutionIds: [subId] },
    ]);
    // A version from day 3 leaves day 2 alone.
    const later = await create(w, w.a, schoolDay(3), slots);
    expect(later.status).toBe(201);
    const sub5 = await keyed(`/sections/${w.a.id}/timetable-substitutions`, { date: d5, period: 3, staffId: w.t2.staffId.toString(), reason: 'Tariq at a workshop' }, w.principal);
    expect(sub5.status).toBe(201);
    // Void: day 5 lies inside the version being voided.
    const voidBlocked = await h.post(`/timetable-versions/${(later.body as Version).id}/void`, { reason: 'Not needed' }, w.principal.cookie);
    expect([voidBlocked.status, errorOf(voidBlocked).code, errorOf(voidBlocked).details]).toEqual([
      409,
      ErrorCode.TIMETABLE_SUBSTITUTIONS_EXIST,
      { substitutionIds: [(sub5.body as Substitution).id] },
    ]);
    await h.post(`/timetable-substitutions/${(sub5.body as Substitution).id}/void`, { reason: 'Not needed' }, w.principal.cookie);
    expect((await h.post(`/timetable-versions/${(later.body as Version).id}/void`, { reason: 'Not needed' }, w.principal.cookie)).status).toBe(200);
    await h.post(`/timetable-substitutions/${subId}/void`, { reason: 'Rearranged' }, w.principal.cookie);
    expect((await create(w, w.a, schoolDay(1), slots)).status).toBe(201);
  });

  // ---------------------------------------------------------------------------- R302, R303

  it('R302: teacher, room and section clashes, a period beyond the day, an off day; the settings cannot drop below a slot', async () => {
    const w = await world();
    const T = schoolDay();
    await create(w, w.a, T, [slotOf(w.english, w.t2, 2, 1, 'Lab'), slotOf(w.maths, w.t1, 2, 8)]);
    const teacher = await create(w, w.b, T, [slotOf(w.english, w.t2, 2, 1)]);
    expect([teacher.status, errorOf(teacher).code, (errorOf(teacher).details as { kind: string }).kind]).toEqual([409, ErrorCode.TIMETABLE_SLOT_CLASH, 'teacher']);
    const room = await create(w, w.b, T, [slotOf(w.maths, w.t3, 2, 1, ' LAB ')]);
    expect([room.status, (errorOf(room).details as { kind: string }).kind]).toEqual([409, 'room']);
    const section = await create(w, w.b, T, [slotOf(w.maths, w.t3, 3, 1), slotOf(w.english, w.t2, 3, 1)]);
    expect([section.status, errorOf(section).details]).toMatchObject([409, { kind: 'section', index: 1 }]);
    const beyond = await create(w, w.b, T, [slotOf(w.maths, w.t3, 3, 9)]);
    expect([beyond.status, fieldsOf(beyond)[0]?.path]).toEqual([422, 'slots[0].period']);
    const lower = await request(h.app.getHttpServer())
      .patch('/api/v1/school/settings')
      .set('Cookie', w.principal.cookie)
      .set('Origin', ORIGIN)
      .send({ periodsPerDay: 7 });
    expect([lower.status, fieldsOf(lower)[0]?.path]).toEqual([422, 'periodsPerDay']);
    await request(h.app.getHttpServer()).patch('/api/v1/school/settings').set('Cookie', w.principal.cookie).set('Origin', ORIGIN).send({ weeklyOffDays: [4] });
    const off = await create(w, w.b, T, [slotOf(w.maths, w.t3, 4, 1)]);
    expect([off.status, errorOf(off).code, errorOf(off).details]).toMatchObject([409, ErrorCode.TIMETABLE_OFF_DAY, { weekday: 4 }]);
    expect((await create(w, w.b, T, [slotOf(w.maths, w.t3, 2, 1, 'Lab 2')])).status).toBe(201);
  });

  it('R303: the teacher must teach the subject in the section on effectiveFrom; an ended assignment shows "no assigned teacher"', async () => {
    const w = await world();
    const T = schoolDay();
    const wrong = await create(w, w.a, T, [slotOf(w.maths, w.t3, 1, 1)]);
    expect([wrong.status, errorOf(wrong).code, errorOf(wrong).details]).toEqual([
      409,
      ErrorCode.TIMETABLE_TEACHER_NOT_ASSIGNED,
      { staffId: w.t3.staffId.toString(), classSubjectId: w.maths, sectionId: w.a.id.toString() },
    ]);
    const english = await create(w, w.a, T, [slotOf(w.english, w.t2, weekdayOf(schoolDay(1)), 1)]);
    expect(english.status).toBe(201);
    // Teacher 2's assignment ends today: tomorrow's grid keeps the slot but says no assigned teacher.
    await db().teacherAssignment.updateMany({ where: { schoolId: w.school.id, staffId: w.t2.staffId }, data: { endsOn: D(T) } });
    const grid = (await h.get(`/timetable/grid?academicYearId=${w.yearId}&date=${schoolDay(1)}`, w.principal.cookie)).body as {
      sections: { sectionName: string; versionId: string | null; cells: Slot[] }[];
      weekday: number;
    };
    expect(grid.weekday).toBe(weekdayOf(schoolDay(1)));
    const a = grid.sections.find((s) => s.sectionName === 'A');
    expect(a?.cells.map((c) => [c.period, c.teacherName, c.assignedTeacher])).toEqual([[1, 'Erum English', false]]);
    expect(grid.sections.find((s) => s.sectionName === 'B')?.versionId).toBeNull();
    expect((await h.get(`/timetable/grid?academicYearId=${w.yearId}`, w.t1.cookie)).status).toBe(403);
  });

  // ---------------------------------------------------------------------------- R304, R306

  it('R304, R306: with a live version a subject teacher marks only their timetabled periods; a substitute marks theirs; the class teacher any', async () => {
    const w = await world();
    const T = schoolDay();
    const wd = weekdayOf(T);
    const marks = [{ enrolmentId: w.child.enrolmentId.toString(), status: 'present' }];
    // No version yet: Phase 2's R120 lets the subject teacher mark any period.
    expect((await h.submit(w.t1.cookie, w.a, { date: T, period: 6, marks })).status).toBe(201);
    await create(w, w.a, T, [slotOf(w.maths, w.t1, wd, 2), slotOf(w.english, w.t2, wd, 4)]);
    expect((await h.submit(w.t1.cookie, w.a, { date: T, period: 2, marks })).status).toBe(201);
    const other = await h.submit(w.t1.cookie, w.a, { date: T, period: 3, marks });
    expect([other.status, errorOf(other).code, errorOf(other).details]).toEqual([
      403,
      ErrorCode.PERMISSION_DENIED,
      { reason: 'not_timetabled_period', period: 3 },
    ]);
    const view = await h.get(`/sections/${w.a.id}/register?date=${T}&period=3`, w.t1.cookie);
    expect([view.status, (view.body as { canSubmit: boolean }).canSubmit]).toEqual([200, false]);
    expect((await h.submit(w.ct.cookie, w.a, { date: T, period: 3, marks })).status).toBe(201);
    expect((await h.submit(w.principal.cookie, w.a, { date: T, period: 5, marks })).status).toBe(201);

    // Teacher 3 holds no assignment in A; a substitution names them for period 4 today.
    expect((await h.submit(w.t3.cookie, w.a, { date: T, period: 4, marks })).status).toBe(404);
    const sub = await keyed(`/sections/${w.a.id}/timetable-substitutions`, { date: T, period: 4, staffId: w.t3.staffId.toString(), reason: 'Erum at a workshop' }, w.principal);
    expect(sub.status).toBe(201);
    expect(sub.body as Substitution).toMatchObject({ regularStaffId: w.t2.staffId.toString(), subjectName: 'English', teacherName: 'Bilal Maths' });
    const subView = await h.get(`/sections/${w.a.id}/register?date=${T}&period=4`, w.t3.cookie);
    expect([subView.status, (subView.body as { canSubmit: boolean; roster: unknown[] }).canSubmit]).toEqual([200, true]);
    expect((subView.body as { roster: unknown[] }).roster).toHaveLength(1);
    expect((await h.submit(w.t3.cookie, w.a, { date: T, period: 4, marks })).status).toBe(201);
    expect((await h.submit(w.t3.cookie, w.a, { date: T, period: 7, marks })).status).toBe(404);
    // The regular teacher keeps their period (they may amend what they recorded).
    expect((await h.submit(w.t2.cookie, w.a, { date: T, period: 4, marks })).status).toBe(200);
    // A void restores the regular teacher alone.
    await h.post(`/timetable-substitutions/${(sub.body as Substitution).id}/void`, { reason: 'Erum came back' }, w.principal.cookie);
    expect((await h.submit(w.t3.cookie, w.a, { date: T, period: 4, marks })).status).toBe(404);
  });

  it('R306: a substitution is one teaching-day period, not the slot teacher, not double-booked; past dates only in the window', async () => {
    const w = await world();
    const T = schoolDay();
    const wd = weekdayOf(schoolDay(2));
    await create(w, w.a, T, [slotOf(w.maths, w.t1, wd, 2)]);
    await create(w, w.b, T, [slotOf(w.maths, w.t3, wd, 2)]);
    const post = (body: object) => keyed(`/sections/${w.a.id}/timetable-substitutions`, body, w.principal);
    const base = { date: schoolDay(2), period: 2, reason: 'Tariq on leave' };
    const same = await post({ ...base, staffId: w.t1.staffId.toString() });
    expect([same.status, errorOf(same).code]).toEqual([409, ErrorCode.TIMETABLE_SUBSTITUTION_SAME_TEACHER]);
    const untimetabled = await post({ ...base, period: 3, staffId: w.t2.staffId.toString() });
    expect([untimetabled.status, errorOf(untimetabled).code]).toEqual([409, ErrorCode.TIMETABLE_SUBSTITUTION_NOT_TIMETABLED]);
    const busy = await post({ ...base, staffId: w.t3.staffId.toString() });
    expect([busy.status, errorOf(busy).code, (errorOf(busy).details as { kind: string }).kind]).toEqual([409, ErrorCode.TIMETABLE_SLOT_CLASH, 'teacher']);
    const ok = await post({ ...base, staffId: w.t2.staffId.toString() });
    expect(ok.status).toBe(201);
    const [created] = await audits(w, 'timetable_substitution.created');
    expect([created?.actorUserId, created?.subjectId, created?.metadata]).toEqual([
      w.principal.userId,
      BigInt((ok.body as Substitution).id),
      { sectionId: w.a.id.toString(), date: schoolDay(2), period: 2, staffId: w.t2.staffId.toString(), regularStaffId: w.t1.staffId.toString() },
    ]);
    const twice = await post({ ...base, staffId: w.ct.staffId.toString() });
    expect([twice.status, errorOf(twice).code]).toEqual([409, ErrorCode.TIMETABLE_SUBSTITUTION_EXISTS]);
    const old = await post({ ...base, date: schoolDay(-10), staffId: w.ct.staffId.toString() });
    expect([old.status, fieldsOf(old)[0]?.path]).toEqual([422, 'date']);
    const list = (await h.get(`/timetable-substitutions?sectionId=${w.a.id}`, w.principal.cookie)).body as { data: Substitution[] };
    expect(list.data.map((s) => [s.date, s.period, s.teacherName])).toEqual([[schoolDay(2), 2, 'Erum English']]);
    const id = (ok.body as Substitution).id;
    const voided = await h.post(`/timetable-substitutions/${id}/void`, { reason: 'Tariq is back' }, w.principal.cookie);
    expect((voided.body as Substitution).voidedAt).not.toBeNull();
    expect((await h.post(`/timetable-substitutions/${id}/void`, { reason: 'Again' }, w.principal.cookie)).status).toBe(200);
    expect(await audits(w, 'timetable_substitution.voided')).toHaveLength(1);
    expect((await post({ ...base, staffId: w.ct.staffId.toString() })).status).toBe(201);
  });

  // ---------------------------------------------------------------------------- R305 and the console

  it('R305: the deadline job lists a timetabled section\'s unrecorded periods ("no assigned teacher"), others by Phase 2; the console names periods', async () => {
    const w = await world();
    const T = schoolDay();
    const wd = weekdayOf(T);
    const marks = [{ enrolmentId: w.child.enrolmentId.toString(), status: 'present' }];
    await create(w, w.a, T, [slotOf(w.maths, w.t1, wd, 1), slotOf(w.english, w.t2, wd, 2)]);
    await h.child(w.school, w.b, { fullName: 'Bano B' });
    expect((await h.submit(w.t1.cookie, w.a, { date: T, period: 1, marks })).status).toBe(201);
    await db().teacherAssignment.updateMany({ where: { schoolId: w.school.id, staffId: w.t2.staffId }, data: { endsOn: D(schoolDay(-1)) } });

    const console = await h.get(`/attendance-registers?date=${T}&sectionId=${w.a.id}`, w.principal.cookie);
    const day = (console.body as { data: { periods: { period: number; subjectName: string | null; teacherName: string | null; recorded: boolean }[] }[] }).data[0];
    expect(day?.periods).toHaveLength(8);
    expect(day?.periods.slice(0, 3)).toEqual([
      { period: 1, subjectName: 'Mathematics', teacherName: 'Tariq Maths', recorded: true },
      { period: 2, subjectName: 'English', teacherName: 'Erum English', recorded: false },
      { period: 3, subjectName: null, teacherName: null, recorded: false },
    ]);

    const sweep = h.app.get(RegisterDeadlineSweep, { strict: false });
    expect(await asSchool(h.app, w.school.id, () => sweep.run(w.school.id, at(T, '10:00')))).toBe('sent');
    const [message] = await db().message.findMany({ where: { schoolId: w.school.id, type: 'register_unrecorded' }, take: 1 });
    expect(message?.body).toContain('Class 5 B');
    expect(message?.body).toContain('Class 5 A P2 English (no assigned teacher)');
    expect(message?.body).not.toContain('A P1');
  });

  it('R305 (wave R review): a live version with no lesson on today\'s weekday falls back to Phase 2 for the day', async () => {
    const w = await world();
    const T = schoolDay();
    await create(w, w.a, T, [slotOf(w.maths, w.t1, weekdayOf(schoolDay(1)), 1)]);
    const sweep = h.app.get(RegisterDeadlineSweep, { strict: false });
    expect(await asSchool(h.app, w.school.id, () => sweep.run(w.school.id, at(T, '10:00')))).toBe('sent');
    const [message] = await db().message.findMany({ where: { schoolId: w.school.id, type: 'register_unrecorded' }, take: 1 });
    expect(message?.body).toMatch(/: 1 register not recorded by 10:00 on .*: Class 5 A$/);
  });

  // ---------------------------------------------------------------------------- R307

  it('R307: a leave request lists the teacher\'s timetabled periods across its teaching days; sectionsNeedingCover unchanged', async () => {
    const w = await world();
    await db().$executeRaw`SELECT asms_seed_school_finance(${w.school.id}::bigint)`;
    const d1 = schoolDay(1);
    const d2 = schoolDay(2);
    await create(w, w.a, schoolDay(1), [slotOf(w.maths, w.t1, weekdayOf(d1), 3), slotOf(w.maths, w.t1, weekdayOf(d2), 1)]);
    const types = (await h.get('/leave-types', w.t1.cookie)).body as { data: { id: string; code: string }[] };
    const casual = types.data.find((t) => t.code === 'casual')!;
    const asked = await keyed('/me/staff/leave-requests', { leaveTypeId: casual.id, startsOn: d1, endsOn: d2, reason: 'Family wedding' }, w.t1);
    expect(asked.status).toBe(201);
    expect((asked.body as { periodsNeedingCover: unknown[]; sectionsNeedingCover: unknown[] }).periodsNeedingCover).toEqual([
      { date: d1, period: 3, sectionId: w.a.id.toString(), sectionName: 'Class 5 A', subjectName: 'Mathematics' },
      { date: d2, period: 1, sectionId: w.a.id.toString(), sectionName: 'Class 5 A', subjectName: 'Mathematics' },
    ]);
    expect((asked.body as { sectionsNeedingCover: unknown[] }).sectionsNeedingCover).toEqual([]);
    // A substitution already taking a period leaves the list.
    await keyed(`/sections/${w.a.id}/timetable-substitutions`, { date: d2, period: 1, staffId: w.t2.staffId.toString(), reason: 'Tariq on leave' }, w.principal);
    const list = (await h.get('/leave-requests?status=pending', w.principal.cookie)).body as { data: { periodsNeedingCover: { date: string }[] }[] };
    expect(list.data[0]?.periodsNeedingCover.map((p) => p.date)).toEqual([d1]);
  });

  // ---------------------------------------------------------------------------- R308, R309

  it('R308: the family reads the child\'s week by names only, the substitute named; staff routes refused', async () => {
    const w = await world();
    const T = schoolDay();
    await create(w, w.a, T, [slotOf(w.maths, w.t1, weekdayOf(T), 1, 'Room 5')]);
    await keyed(`/sections/${w.a.id}/timetable-substitutions`, { date: T, period: 1, staffId: w.t3.staffId.toString(), reason: 'Tariq unwell today' }, w.principal);
    const parent = await guardianLogin(db(), w.school, { id: w.child.guardianId, cnic: null });
    const res = await h.get(`/me/children/${w.child.studentId}/timetable`, parent.cookie);
    expect(res.status).toBe(200);
    const body = res.body as { sectionName: string; className: string; days: { date: string; periods: object[] }[] };
    expect([body.className, body.sectionName]).toEqual(['Class 5', 'A']);
    const today = body.days.find((d) => d.date === T);
    expect(today?.periods).toEqual([{ period: 1, subjectName: 'Mathematics', teacherName: 'Bilal Maths', room: 'Room 5' }]);
    expect(res.text).not.toMatch(/staffId|versionId|reason|unwell/);
    const other = await h.child(w.school, w.b);
    expect((await h.get(`/me/children/${other.studentId}/timetable`, parent.cookie)).status).toBe(404);
    expect((await h.get(`/sections/${w.a.id}/timetable`, parent.cookie)).status).toBe(403);
    const student = await studentLogin(db(), w.school, { id: w.child.studentId, bForm: null });
    const own = (await h.get('/me/student/timetable', student.cookie)).body as { days: { date: string; periods: object[] }[] };
    expect(own.days.find((d) => d.date === T)?.periods).toHaveLength(1);
  });

  it('R309: a week spanning two versions shows each day\'s own; the teacher\'s own week across sections', async () => {
    const w = await world();
    const monday = mondayOf(D(schoolDay(7))).toISOString().slice(0, 10);
    const thursday = addDays(D(monday), 3).toISOString().slice(0, 10);
    const v1 = (await create(w, w.a, monday, [slotOf(w.maths, w.t1, 1, 1), slotOf(w.maths, w.t1, 4, 1)])).body as Version;
    const v2 = (await create(w, w.a, thursday, [slotOf(w.maths, w.t1, 4, 2)])).body as Version;
    await create(w, w.b, monday, [slotOf(w.english, w.t2, 4, 5)]);
    const week = (await h.get(`/sections/${w.a.id}/timetable?date=${thursday}`, w.t3.cookie)).body as {
      weekOf: string;
      days: { date: string; versionId: string | null; slots: Slot[] }[];
    };
    expect(week.weekOf).toBe(monday);
    expect(week.days.map((d) => d.versionId)).toEqual([v1.id, v1.id, v1.id, v2.id, v2.id, v2.id, v2.id]);
    expect(week.days[0]?.slots.map((s) => s.period)).toEqual([1]);
    expect(week.days[3]?.slots.map((s) => s.period)).toEqual([2]);
    const mine = (await h.get(`/me/staff/timetable?weekOf=${thursday}`, w.t1.cookie)).body as {
      days: { date: string; periods: { period: number; sectionName: string; kind: string }[] }[];
    };
    expect(mine.days.map((d) => d.periods.map((p) => p.period))).toEqual([[1], [], [], [2], [], [], []]);
    const t2Week = (await h.get(`/me/staff/timetable?weekOf=${monday}`, w.t2.cookie)).body as typeof mine;
    expect(t2Week.days[3]?.periods).toMatchObject([{ period: 5, sectionName: 'B', kind: 'slot' }]);
  });
});
