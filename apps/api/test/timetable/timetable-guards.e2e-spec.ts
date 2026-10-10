// Slice 37 in the database (phase-5-extended.md §3.2 "Timetable", R301, R302, R306;
// contracts/slice-37.md §6): every trigger and exclusion constraint of timetable_versions,
// timetable_slots and timetable_substitutions, written directly. Each statement is raw SQL inside
// one transaction that is rolled back, behind its own savepoint, so nothing here changes or removes
// a row even if a guard were missing (an exemption in guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, createSubject } from '../support/students';

const TABLES = ['timetable_versions', 'timetable_slots', 'timetable_substitutions'];

describe('slice 37 timetable guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let schoolId: bigint;
  let otherSchoolId: bigint;
  let userId: bigint;
  let yearId: bigint;
  let classId: bigint;
  let sectionA: bigint;
  let sectionB: bigint;
  let sectionC: bigint;
  let maths: bigint;
  let english: bigint;
  let teacher1: bigint;
  let teacher2: bigint;

  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    const savepoint = `guard_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      await pg.query(sql, params);
      return null;
    } catch (error) {
      const e = error as DatabaseError;
      return e.constraint ?? e.detail?.replace(/^constraint: /, '') ?? e.message;
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  };

  const truncateRefused = async (table: string): Promise<string | null> => {
    const refusal = await refusedBy(`TRUNCATE ${table}`);
    if (refusal === null || !/lock timeout/i.test(refusal)) return refusal;
    const guard = await pg.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND (tgtype & 32) <> 0 AND NOT tgisinternal`,
      [table],
    );
    return (guard.rowCount ?? 0) > 0 ? `${table}: guarded (busy)` : null;
  };

  /** A version of `section` inside the open transaction (kept until the final rollback). */
  const version = async (section: bigint, from: string, to: string | null = null): Promise<bigint> => {
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO timetable_versions (school_id, section_id, class_id, academic_year_id, effective_from, effective_to, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [schoolId, section, classId, yearId, from, to, userId],
    );
    return BigInt(rows[0]!.id);
  };

  const slotSql = `INSERT INTO timetable_slots (school_id, version_id, class_id, weekday, period, class_subject_id, staff_id, room, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2000-01-01') RETURNING id`;
  const slot = async (
    versionId: bigint,
    s: { weekday: number; period: number; subject?: bigint; staff?: bigint; room?: string | null },
  ): Promise<bigint> => {
    const { rows } = await pg.query<{ id: string }>(slotSql, [
      schoolId,
      versionId,
      classId,
      s.weekday,
      s.period,
      s.subject ?? maths,
      s.staff ?? teacher1,
      s.room ?? null,
    ]);
    return BigInt(rows[0]!.id);
  };
  const slotRefused = (versionId: bigint, s: { weekday: number; period: number; staff?: bigint; room?: string | null }) =>
    refusedBy(slotSql, [schoolId, versionId, classId, s.weekday, s.period, maths, s.staff ?? teacher1, s.room ?? null]);
  const slotRange = async (id: bigint) =>
    (
      await pg.query<{ f: string; t: string | null; v: boolean }>(
        `SELECT effective_from::text AS f, effective_to::text AS t, voided_at IS NOT NULL AS v FROM timetable_slots WHERE id = $1`,
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    const school = await createSchool();
    schoolId = school.id;
    otherSchoolId = (await createSchool()).id;
    userId = (await createSchoolUser(db, school, { systemRole: 'principal' })).userId;
    teacher1 = (await createSchoolUser(db, school, { systemRole: 'teacher' })).staffId;
    teacher2 = (await createSchoolUser(db, school, { systemRole: 'teacher' })).staffId;
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    yearId = year.id;
    const klass = await createClass(db, school, year, { attendanceMode: 'period' });
    classId = klass.id;
    sectionA = (await createSection(db, school, klass)).id;
    sectionB = (await createSection(db, school, klass)).id;
    sectionC = (await createSection(db, school, klass)).id;
    // Friday (5) off; eight periods a day.
    await db.schoolSettings.create({ data: { schoolId, periodsPerDay: 8, weeklyOffDays: [5] } });
    const classSubject = async () =>
      (
        await db.classSubject.create({
          data: { schoolId, academicYearId: yearId, classId, subjectId: (await createSubject(db, school)).id, sortOrder: 1 },
        })
      ).id;
    maths = await classSubject();
    english = await classSubject();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL lock_timeout = '5s'`);
  });

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  // ---------------------------------------------------------------------------- versions

  it('R301: a section has one live version per day; a voided one leaves the exclusion; another section is free', async () => {
    const v1 = await version(sectionA, '2026-05-01', '2026-05-31');
    expect(await refusedBy(
      `INSERT INTO timetable_versions (school_id, section_id, class_id, academic_year_id, effective_from, created_by)
       VALUES ($1, $2, $3, $4, '2026-05-31', $5)`,
      [schoolId, sectionA, classId, yearId, userId],
    )).toBe('timetable_versions_live_excl');
    await version(sectionB, '2026-05-01', '2026-05-31');
    await pg.query(`UPDATE timetable_versions SET voided_at = now(), voided_by = $2, void_reason = 'Wrong week' WHERE id = $1`, [v1, userId]);
    expect(await version(sectionA, '2026-05-15', '2026-05-31')).toBeGreaterThan(0n);
  });

  it('R301: effective_from inside the year, effective_to not before it, born live', async () => {
    const insert = (from: string, to: string | null, voided = false) =>
      refusedBy(
        `INSERT INTO timetable_versions (school_id, section_id, class_id, academic_year_id, effective_from, effective_to, created_by, voided_at, voided_by, void_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [schoolId, sectionA, classId, yearId, from, to, userId, voided ? new Date() : null, voided ? userId : null, voided ? 'Nope' : null],
      );
    expect(await insert('2026-03-31', null)).toBe('timetable_versions_in_year');
    expect(await insert('2027-04-01', null)).toBe('timetable_versions_in_year');
    expect(await insert('2027-02-01', '2027-01-31')).toBe('timetable_versions_dates_check');
    expect(await insert('2027-02-01', null, true)).toBe('timetable_versions_born_live');
  });

  it('rule 33: a version is never edited — only effective_to and the void trio change; a voided range is frozen', async () => {
    const v = await version(sectionA, '2026-06-01', '2026-06-10');
    for (const [column, value] of [
      ['section_id', sectionB],
      ['effective_from', '2026-06-02'],
      ['academic_year_id', yearId + 1n],
      ['created_by', userId + 1n],
    ] as const) {
      expect(await refusedBy(`UPDATE timetable_versions SET ${column} = $2 WHERE id = $1`, [v, value])).toBe(
        `timetable_versions_${column}_immutable`,
      );
    }
    expect(await refusedBy(`UPDATE timetable_versions SET effective_to = '2026-06-12' WHERE id = $1`, [v])).toBeNull();
    await pg.query(`UPDATE timetable_versions SET voided_at = now(), voided_by = $2, void_reason = 'Wrong' WHERE id = $1`, [v, userId]);
    expect(await refusedBy(`UPDATE timetable_versions SET effective_to = NULL WHERE id = $1`, [v])).toBe('timetable_versions_voided_frozen');
    expect(await refusedBy(`UPDATE timetable_versions SET void_reason = 'Other' WHERE id = $1`, [v])).toBe('timetable_versions_void_reason_frozen');
    expect(await refusedBy(`UPDATE timetable_versions SET voided_by = NULL, voided_at = NULL, void_reason = NULL WHERE id = $1`, [v])).toBe(
      'timetable_versions_voided_at_frozen',
    );
    expect(await refusedBy(`UPDATE timetable_versions SET voided_at = now() WHERE id = $1 AND voided_at IS NULL`, [v])).toBeNull();
  });

  // ---------------------------------------------------------------------------- slots

  it('§3.2: a slot carries its version range and void, on insert and whenever the version changes', async () => {
    const v = await version(sectionA, '2026-07-01');
    const s = await slot(v, { weekday: 1, period: 1 });
    expect(await slotRange(s)).toEqual({ f: '2026-07-01', t: null, v: false });
    await pg.query(`UPDATE timetable_versions SET effective_to = '2026-07-20' WHERE id = $1`, [v]);
    expect(await slotRange(s)).toEqual({ f: '2026-07-01', t: '2026-07-20', v: false });
    // A direct write of the copy is overwritten by the version's value.
    await pg.query(`UPDATE timetable_slots SET effective_to = '2026-12-31', voided_at = now() WHERE id = $1`, [s]);
    expect(await slotRange(s)).toEqual({ f: '2026-07-01', t: '2026-07-20', v: false });
    await pg.query(`UPDATE timetable_versions SET voided_at = now(), voided_by = $2, void_reason = 'Wrong' WHERE id = $1`, [v, userId]);
    expect((await slotRange(s))?.v).toBe(true);
    expect(await slotRefused(v, { weekday: 2, period: 1 })).toBe('timetable_slots_version_voided');
  });

  it('R302: a teacher once per weekday-period over overlapping ranges; not when the ranges miss or a version is voided', async () => {
    const a = await version(sectionA, '2026-08-01', '2026-08-31');
    const b = await version(sectionB, '2026-08-15', '2026-09-30');
    await slot(a, { weekday: 1, period: 2, staff: teacher1 });
    expect(await slotRefused(b, { weekday: 1, period: 2, staff: teacher1 })).toBe('timetable_slots_teacher_excl');
    expect(await slotRefused(b, { weekday: 1, period: 3, staff: teacher1 })).toBeNull();
    expect(await slotRefused(b, { weekday: 2, period: 2, staff: teacher1 })).toBeNull();
    expect(await slotRefused(b, { weekday: 1, period: 2, staff: teacher2 })).toBeNull();
    const later = await version(sectionB, '2026-10-01', '2026-10-31');
    expect(await slotRefused(later, { weekday: 1, period: 2, staff: teacher1 })).toBeNull();
  });

  it('R302: a room once per weekday-period, compared trimmed and lower-cased; two slots of one version-period refused', async () => {
    const a = await version(sectionA, '2026-11-01', '2026-11-30');
    const b = await version(sectionB, '2026-11-01', '2026-11-30');
    await slot(a, { weekday: 3, period: 4, staff: teacher1, room: 'Lab 1' });
    expect(await slotRefused(b, { weekday: 3, period: 4, staff: teacher2, room: 'lab 1' })).toBe('timetable_slots_room_excl');
    expect(await slotRefused(b, { weekday: 3, period: 4, staff: teacher2, room: ' Lab 1' })).toBe('timetable_slots_room_check');
    expect(await slotRefused(b, { weekday: 3, period: 4, staff: teacher2, room: 'Lab 2' })).toBeNull();
    expect(await slotRefused(b, { weekday: 3, period: 4, staff: teacher2, room: null })).toBeNull();
    expect(await slotRefused(a, { weekday: 3, period: 4, staff: teacher2 })).toBe('timetable_slots_version_weekday_period_key');
    expect(await slotRefused(b, { weekday: 3, period: 5, staff: teacher2, room: '3520112345671' })).toBe('timetable_slots_room_no_id_check');
  });

  it('R302: a period beyond periods_per_day, a weekly-off day, a weekday or period out of range are refused', async () => {
    const v = await version(sectionA, '2026-12-01', '2026-12-31');
    expect(await slotRefused(v, { weekday: 1, period: 9 })).toBe('timetable_slots_period_in_day');
    expect(await slotRefused(v, { weekday: 5, period: 1 })).toBe('timetable_slots_off_day');
    expect(await slotRefused(v, { weekday: 7, period: 1 })).toBe('timetable_slots_weekday_check');
    // The guard answers first; the CHECK backs it for a school whose setting is missing.
    expect(await slotRefused(v, { weekday: 1, period: 13 })).toBe('timetable_slots_period_in_day');
    expect(await slotRefused(v, { weekday: 1, period: 8 })).toBeNull();
  });

  it('rule 33: a slot is never edited', async () => {
    const v = await version(sectionA, '2027-01-01', '2027-01-10');
    const s = await slot(v, { weekday: 1, period: 1, room: 'Room 9' });
    for (const [column, value] of [
      ['weekday', 2],
      ['period', 2],
      ['staff_id', teacher2],
      ['class_subject_id', english],
      ['room', 'Room 10'],
    ] as const) {
      expect(await refusedBy(`UPDATE timetable_slots SET ${column} = $2 WHERE id = $1`, [s, value])).toBe(
        `timetable_slots_${column}_immutable`,
      );
    }
  });

  it('R301: voiding a future version restores its predecessor, and the restore re-checks clashes', async () => {
    const v1 = await version(sectionA, '2027-02-01', '2027-02-14');
    const s1 = await slot(v1, { weekday: 1, period: 6, staff: teacher2 });
    const v2 = await version(sectionA, '2027-02-15');
    await slot(v2, { weekday: 1, period: 6, staff: teacher1 });
    // Section B takes teacher 2 at Monday P6 from 2027-02-15, while v2 holds section A.
    const b = await version(sectionB, '2027-02-15');
    await slot(b, { weekday: 1, period: 6, staff: teacher2 });
    await pg.query(`UPDATE timetable_versions SET voided_at = now(), voided_by = $2, void_reason = 'Mistake' WHERE id = $1`, [v2, userId]);
    expect(await refusedBy(`UPDATE timetable_versions SET effective_to = NULL WHERE id = $1`, [v1])).toBe('timetable_slots_teacher_excl');
    // Without the clash the predecessor grows back over the voided range, its slots with it.
    await pg.query(`UPDATE timetable_versions SET voided_at = now(), voided_by = $2, void_reason = 'Undo' WHERE id = $1`, [b, userId]);
    await pg.query(`UPDATE timetable_versions SET effective_to = NULL WHERE id = $1`, [v1]);
    expect(await slotRange(s1)).toEqual({ f: '2027-02-01', t: null, v: false });
  });

  it('§3.2: periods_per_day cannot drop below a period a live or future slot uses', async () => {
    const v = await version(sectionB, '2027-03-01');
    await slot(v, { weekday: 2, period: 8, staff: teacher2 });
    expect(await refusedBy(`UPDATE school_settings SET periods_per_day = 7 WHERE school_id = $1`, [schoolId])).toBe(
      'school_settings_periods_per_day_timetabled',
    );
    expect(await refusedBy(`UPDATE school_settings SET periods_per_day = 10 WHERE school_id = $1`, [schoolId])).toBeNull();
  });

  // ---------------------------------------------------------------------------- substitutions

  it('R306: one live substitution per section-date-period and per substitute-date-period; a void frees it; frozen', async () => {
    const sql = (section: bigint, staff: bigint, period: number) => [
      `INSERT INTO timetable_substitutions (school_id, section_id, class_id, date, period, staff_id, reason, created_by)
         VALUES ($1, $2, $3, '2026-09-07', $4, $5, 'Teacher on leave', $6)`,
      [schoolId, section, classId, period, staff, userId],
    ] as const;
    const keep = async (section: bigint, staff: bigint, period = 1) => {
      const [text, params] = sql(section, staff, period);
      await pg.query(text, [...params]);
    };
    const insert = (section: bigint, staff: bigint, period = 1) =>
      refusedBy(
        `INSERT INTO timetable_substitutions (school_id, section_id, class_id, date, period, staff_id, reason, created_by)
         VALUES ($1, $2, $3, '2026-09-07', $4, $5, 'Teacher on leave', $6)`,
        [schoolId, section, classId, period, staff, userId],
      );
    await keep(sectionA, teacher1);
    expect(await insert(sectionA, teacher2)).toBe('timetable_substitutions_live_key');
    expect(await insert(sectionB, teacher1)).toBe('timetable_substitutions_staff_live_key');
    expect(await insert(sectionB, teacher1, 2)).toBeNull();
    expect(await insert(sectionB, teacher2, 13)).toBe('timetable_substitutions_period_check');
    await pg.query(
      `UPDATE timetable_substitutions SET voided_at = now(), voided_by = $2, void_reason = 'Back early'
        WHERE school_id = $1 AND section_id = $3 AND period = 1 AND voided_at IS NULL`,
      [schoolId, userId, sectionA],
    );
    await keep(sectionA, teacher2);
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM timetable_substitutions WHERE school_id = $1 AND section_id = $2 AND voided_at IS NULL`,
      [schoolId, sectionA],
    );
    const id = rows[0]!.id;
    expect(await refusedBy(`UPDATE timetable_substitutions SET staff_id = $2 WHERE id = $1`, [id, teacher1])).toBe(
      'timetable_substitutions_staff_id_immutable',
    );
    expect(await refusedBy(`UPDATE timetable_substitutions SET reason = 'Other' WHERE id = $1`, [id])).toBe(
      'timetable_substitutions_reason_immutable',
    );
  });

  // ---------------------------------------------------------------------------- the trio

  it.each(TABLES.map((table, i) => [table, i] as const))('%s: no delete, no truncate, school_id immutable', async (table, i) => {
    const day = `2027-03-${String(20 + i * 3).padStart(2, '0')}`;
    const v = await version(sectionC, day, day);
    await slot(v, { weekday: new Date(`${day}T00:00:00Z`).getUTCDay() === 5 ? 1 : new Date(`${day}T00:00:00Z`).getUTCDay(), period: 7, staff: teacher1 });
    await pg.query(
      `INSERT INTO timetable_substitutions (school_id, section_id, class_id, date, period, staff_id, reason, created_by)
       VALUES ($1, $2, $3, $4, 7, $5, 'Cover', $6)`,
      [schoolId, sectionC, classId, day, teacher2, userId],
    );
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_no_delete`);
    expect(await truncateRefused(table)).not.toBeNull();
    expect(await refusedBy(`UPDATE ${table} SET school_id = $2 WHERE school_id = $1`, [schoolId, otherSchoolId])).toBe(
      `${table}_school_id_immutable`,
    );
  });
});
