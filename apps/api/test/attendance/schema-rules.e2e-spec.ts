// The hand-written rules of the wave-E attendance schema (migration
// 20261004120000_phase2_attendance_diary): registers, marks, the §4.6 history trigger, the summary
// version bump, alerts, day status and staff attendance. Driven with raw SQL inside one
// transaction that is rolled back, each refused statement behind its own savepoint.
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createStudent,
  enrol,
  type TestSection,
} from '../support/students';

describe('attendance schema rules (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let school: TestSchool;
  let principal: TestSchoolUser;
  let teacher: TestSchoolUser;
  let office: TestSchoolUser;
  let outsider: TestSchoolUser;
  let section: TestSection;
  let other: TestSection;
  let enrolments: bigint[];
  let students: bigint[];
  let seq = 0;

  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    const savepoint = `rule_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      await pg.query(sql, params);
      return null;
    } catch (error) {
      return (error as DatabaseError).constraint ?? (error as Error).message;
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  };

  const run = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> =>
    (await pg.query<T>(sql, params)).rows[0] as T;

  const count = async (sql: string, params: unknown[] = []): Promise<number> =>
    Number((await run<{ n: string }>(sql, params)).n);

  /** The transaction-local change context, as ChangeContextRepository writes it; '' clears. */
  const context = (actor: bigint | '' = '', reason = '') =>
    run(`SELECT set_config('asms.actor_user_id', $1, true), set_config('asms.change_reason', $2, true)`, [
      actor.toString(),
      reason,
    ]);

  const register = (target: TestSection, date: string, period = 1, mode = 'daily') =>
    run<{ id: string }>(
      `INSERT INTO attendance_registers (school_id, section_id, class_id, academic_year_id, date, period, mode,
                                         submitted_by, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'web') RETURNING id`,
      [school.id, target.id, target.classId, target.academicYearId, date, period, mode, teacher.userId],
    );

  const mark = (registerId: string, enrolmentId: bigint, date: string, period = 1, status = 'present') =>
    run<{ id: string }>(
      `INSERT INTO attendance_marks (school_id, register_id, enrolment_id, date, period, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [school.id, registerId, enrolmentId, date, period, status],
    );

  const summary = (
    target: TestSection,
    date: string,
  ): Promise<{ version: string; computed_version: string } | undefined> =>
    run<{ version: string; computed_version: string }>(
      `SELECT version, computed_version FROM attendance_daily_summary
        WHERE school_id = $1 AND section_id = $2 AND date = $3`,
      [school.id, target.id, date],
    );

  beforeAll(async () => {
    school = await createSchool();
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    outsider = await createSchoolUser(db, await createSchool(), { systemRole: 'principal' });
    ({ section } = await createClassWithSection(db, school));
    ({ section: other } = await createClassWithSection(db, school));
    const kids = [await createStudent(db, school), await createStudent(db, school)];
    students = kids.map((k) => k.id);
    enrolments = [];
    for (const kid of kids) enrolments.push((await enrol(db, school, kid, section)).id);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
  });

  beforeEach(() => context());

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  it('R119/R121: one register per section, date and period; period 1-12, and 1 in daily mode', async () => {
    const first = await register(section, '2026-09-01');
    expect(await refusedBy(`INSERT INTO attendance_registers (school_id, section_id, class_id, academic_year_id,
        date, period, mode, submitted_by, source) SELECT school_id, section_id, class_id, academic_year_id,
        date, period, mode, submitted_by, source FROM attendance_registers WHERE id = $1`, [first.id])).toBe(
      'attendance_registers_natural_key',
    );
    const insert = (period: number, mode: string) =>
      refusedBy(
        `INSERT INTO attendance_registers (school_id, section_id, class_id, academic_year_id, date, period, mode,
                                           submitted_by, source)
         VALUES ($1, $2, $3, $4, '2026-09-02', $5, $6, $7, 'app')`,
        [school.id, section.id, section.classId, section.academicYearId, period, mode, teacher.userId],
      );
    expect(await insert(2, 'daily')).toBe('attendance_registers_daily_period_check');
    expect(await insert(13, 'period')).toBe('attendance_registers_period_check');
    expect(await insert(12, 'period')).toBeNull();
    // A register names its section's own class and year.
    expect(
      await refusedBy(
        `INSERT INTO attendance_registers (school_id, section_id, class_id, academic_year_id, date, period, mode,
                                           submitted_by, source)
         VALUES ($1, $2, $3, $4, '2026-09-02', 1, 'daily', $5, 'web')`,
        [school.id, section.id, other.classId, other.academicYearId, teacher.userId],
      ),
    ).toBe('attendance_registers_section_id_fkey');
  });

  it('a register’s identity is frozen; only the last amendment moves, and both of its columns together', async () => {
    const { id } = await register(section, '2026-09-03');
    expect(await refusedBy(`UPDATE attendance_registers SET date = '2026-09-04' WHERE id = $1`, [id])).toBe(
      'attendance_registers_date_immutable',
    );
    expect(await refusedBy(`UPDATE attendance_registers SET submitted_by = $2 WHERE id = $1`, [id, office.userId])).toBe(
      'attendance_registers_submitted_by_immutable',
    );
    expect(await refusedBy(`UPDATE attendance_registers SET last_amended_by = $2 WHERE id = $1`, [id, office.userId])).toBe(
      'attendance_registers_amended_check',
    );
    expect(
      await refusedBy(`UPDATE attendance_registers SET last_amended_by = $2, last_amended_at = now() WHERE id = $1`, [
        id,
        office.userId,
      ]),
    ).toBeNull();
  });

  it('rule 14: a mark agrees with its register’s date and period, and one per enrolment, date and period', async () => {
    const reg = await register(section, '2026-09-05');
    expect(
      await refusedBy(
        `INSERT INTO attendance_marks (school_id, register_id, enrolment_id, date, period, status)
         VALUES ($1, $2, $3, '2026-09-06', 1, 'present')`,
        [school.id, reg.id, enrolments[0]],
      ),
    ).toBe('attendance_marks_register_id_fkey');
    await mark(reg.id, enrolments[0]!, '2026-09-05');
    // The same child, day and period in another section's register (a moved child) is refused.
    const otherReg = await register(other, '2026-09-05');
    expect(
      await refusedBy(
        `INSERT INTO attendance_marks (school_id, register_id, enrolment_id, date, period, status)
         VALUES ($1, $2, $3, '2026-09-05', 1, 'absent')`,
        [school.id, otherReg.id, enrolments[0]],
      ),
    ).toBe('attendance_marks_natural_key');
    expect(
      await refusedBy(
        `INSERT INTO attendance_marks (school_id, register_id, enrolment_id, date, period, status, note)
         VALUES ($1, $2, $3, '2026-09-05', 1, 'absent', 'CNIC 3520112345671')`,
        [school.id, reg.id, enrolments[1]],
      ),
    ).toBe('attendance_marks_note_no_id_check');
  });

  it('a mark’s identity columns are frozen', async () => {
    const reg = await register(section, '2026-09-07');
    const { id } = await mark(reg.id, enrolments[0]!, '2026-09-07');
    expect(await refusedBy(`UPDATE attendance_marks SET enrolment_id = $2 WHERE id = $1`, [id, enrolments[1]])).toBe(
      'attendance_marks_enrolment_id_immutable',
    );
    expect(await refusedBy(`UPDATE attendance_marks SET created_at = now() - interval '1 day' WHERE id = $1`, [id])).toBe(
      'attendance_marks_created_at_immutable',
    );
  });

  it('§4.6/R122: a status or note change needs a transaction-local actor and reason, and is recorded', async () => {
    const reg = await register(section, '2026-09-08');
    const { id } = await mark(reg.id, enrolments[0]!, '2026-09-08', 1, 'absent');
    const toLate = `UPDATE attendance_marks SET status = 'late', note = 'Bus' WHERE id = $1`;
    expect(await refusedBy(toLate, [id])).toBe('attendance_mark_changes_actor_required');
    await context(teacher.userId);
    expect(await refusedBy(toLate, [id])).toBe('attendance_mark_changes_reason_required');
    await context(teacher.userId, '   ');
    expect(await refusedBy(toLate, [id])).toBe('attendance_mark_changes_reason_required');
    // An actor of another school fails the composite FK.
    await context(outsider.userId, 'Arrived at 09:40');
    expect(await refusedBy(toLate, [id])).toBe('attendance_mark_changes_changed_by_fkey');

    await context(teacher.userId, 'Arrived at 09:40');
    expect(await refusedBy(toLate, [id])).toBeNull();
    await pg.query(toLate, [id]);
    const change = await run<Record<string, unknown>>(
      `SELECT old_status, new_status, old_note, new_note, changed_by, reason FROM attendance_mark_changes
        WHERE school_id = $1 AND mark_id = $2`,
      [school.id, id],
    );
    expect(change).toEqual({
      old_status: 'absent',
      new_status: 'late',
      old_note: null,
      new_note: 'Bus',
      changed_by: teacher.userId.toString(),
      reason: 'Arrived at 09:40',
    });
    // The reason is checked like any free text.
    await context(teacher.userId, 'Mother CNIC 35201-1234567-1');
    expect(await refusedBy(`UPDATE attendance_marks SET status = 'present' WHERE id = $1`, [id])).toBe(
      'attendance_mark_changes_reason_no_id_check',
    );
  });

  it('R125: a no-op update and an arrival-time-only update need no actor and write no history', async () => {
    const reg = await register(section, '2026-09-09');
    const { id } = await mark(reg.id, enrolments[0]!, '2026-09-09', 1, 'absent');
    expect(await refusedBy(`UPDATE attendance_marks SET status = 'absent', note = NULL WHERE id = $1`, [id])).toBeNull();
    expect(await refusedBy(`UPDATE attendance_marks SET arrived_at = '09:40' WHERE id = $1`, [id])).toBeNull();
    // The register's one-statement upsert: an identical replay is untouched, a change is recorded.
    const upsert = (status: string) =>
      pg.query(
        `INSERT INTO attendance_marks (school_id, register_id, enrolment_id, date, period, status)
         VALUES ($1, $2, $3, '2026-09-09', 1, $4)
         ON CONFLICT ON CONSTRAINT attendance_marks_natural_key
         DO UPDATE SET status = EXCLUDED.status
         WHERE attendance_marks.status IS DISTINCT FROM EXCLUDED.status`,
        [school.id, reg.id, enrolments[0], status],
      );
    await upsert('absent');
    await context(teacher.userId, 'Was in the library');
    await upsert('present');
    expect(
      await count(`SELECT count(*) AS n FROM attendance_mark_changes WHERE school_id = $1 AND mark_id = $2`, [
        school.id,
        id,
      ]),
    ).toBe(1);
  });

  it('§4.6: the settings are transaction-local, so a rolled-back savepoint takes them with it', async () => {
    const reg = await register(section, '2026-09-10');
    const { id } = await mark(reg.id, enrolments[0]!, '2026-09-10', 1, 'absent');
    await pg.query('SAVEPOINT ctx');
    await context(teacher.userId, 'Arrived');
    await pg.query('ROLLBACK TO SAVEPOINT ctx');
    expect(await refusedBy(`UPDATE attendance_marks SET status = 'late' WHERE id = $1`, [id])).toBe(
      'attendance_mark_changes_actor_required',
    );
  });

  it('attendance_mark_changes and attendance_arrivals are append-only', async () => {
    const reg = await register(section, '2026-09-11');
    const { id } = await mark(reg.id, enrolments[0]!, '2026-09-11', 1, 'absent');
    await context(office.userId, 'Arrived at 09:50');
    await pg.query(`UPDATE attendance_marks SET status = 'late', arrived_at = '09:50' WHERE id = $1`, [id]);
    expect(await refusedBy(`UPDATE attendance_mark_changes SET reason = 'Edited' WHERE mark_id = $1`, [id])).toBe(
      'attendance_mark_changes_append_only',
    );
    const arrival = await run<{ id: string }>(
      `INSERT INTO attendance_arrivals (school_id, mark_id, arrived_at, recorded_by)
       VALUES ($1, $2, '09:50', $3) RETURNING id`,
      [school.id, id, office.userId],
    );
    expect(await refusedBy(`UPDATE attendance_arrivals SET arrived_at = '09:30' WHERE id = $1`, [arrival.id])).toBe(
      'attendance_arrivals_append_only',
    );
  });

  it('R131: every mark statement bumps its section-day summary version once; a no-op statement does not', async () => {
    const date = '2026-09-14';
    expect(await summary(section, date)).toBeUndefined();
    const reg = await register(section, date);
    // One statement, two marks: the row is created at version 1.
    await pg.query(
      `INSERT INTO attendance_marks (school_id, register_id, enrolment_id, date, period, status)
       VALUES ($1, $2, $3, $5, 1, 'present'), ($1, $2, $4, $5, 1, 'absent')`,
      [school.id, reg.id, enrolments[0], enrolments[1], date],
    );
    expect(await summary(section, date)).toEqual({ version: '1', computed_version: '0' });
    // An update statement (two rows) bumps once.
    await context(teacher.userId, 'Corrected');
    await pg.query(`UPDATE attendance_marks SET status = 'late' WHERE school_id = $1 AND register_id = $2`, [
      school.id,
      reg.id,
    ]);
    expect((await summary(section, date))?.version).toBe('2');
    // A replayed upsert that changes nothing fires both statement triggers with empty tables.
    await pg.query(
      `INSERT INTO attendance_marks (school_id, register_id, enrolment_id, date, period, status)
       VALUES ($1, $2, $3, $4, 1, 'late')
       ON CONFLICT ON CONSTRAINT attendance_marks_natural_key
       DO UPDATE SET status = EXCLUDED.status WHERE attendance_marks.status IS DISTINCT FROM EXCLUDED.status`,
      [school.id, reg.id, enrolments[0], date],
    );
    expect((await summary(section, date))?.version).toBe('2');
    // Another section's marks touch only their own row.
    expect(await summary(other, date)).toBeUndefined();
    // The worker records only a version it has read.
    expect(
      await refusedBy(
        `UPDATE attendance_daily_summary SET computed_version = version + 1 WHERE school_id = $1 AND section_id = $2 AND date = $3`,
        [school.id, section.id, date],
      ),
    ).toBe('attendance_daily_summary_version_check');
    expect(
      await refusedBy(
        `UPDATE attendance_daily_summary SET date = '2026-09-15' WHERE school_id = $1 AND section_id = $2 AND date = $3`,
        [school.id, section.id, date],
      ),
    ).toBe('attendance_daily_summary_date_immutable');
  });

  it('R126: alerts are unique per child, day, kind and seq; cancelled carries a reason; sent and cancelled are final', async () => {
    const alert = (kind: string, seqNo = 1, studentId = students[0], status = 'pending', reason: string | null = null) =>
      `INSERT INTO attendance_alerts (school_id, enrolment_id, student_id, date, kind, seq, due_at, status, cancel_reason)
       VALUES (${school.id}, ${enrolments[0]}, ${studentId}, '2026-09-16', '${kind}', ${seqNo}, now(), '${status}',
               ${reason === null ? 'NULL' : `'${reason}'`}) RETURNING id`;
    const { id } = await run<{ id: string }>(alert('absence'));
    expect(await refusedBy(alert('absence'))).toBe('attendance_alerts_natural_key');
    expect(await refusedBy(alert('corrected', 0))).toBe('attendance_alerts_seq_check');
    expect(await refusedBy(alert('late', 1, students[1]))).toBe('attendance_alerts_enrolment_id_fkey');
    expect(await refusedBy(alert('late', 1, students[0], 'cancelled'))).toBe('attendance_alerts_cancelled_check');
    expect(await refusedBy(`UPDATE attendance_alerts SET kind = 'late' WHERE id = $1`, [id])).toBe(
      'attendance_alerts_kind_immutable',
    );
    await pg.query(`UPDATE attendance_alerts SET status = 'sent' WHERE id = $1`, [id]);
    expect(await refusedBy(`UPDATE attendance_alerts SET status = 'cancelled', cancel_reason = 'holiday' WHERE id = $1`, [id])).toBe(
      'attendance_alerts_status_final',
    );
    expect(await refusedBy(`UPDATE attendance_alerts SET updated_at = now() WHERE id = $1`, [id])).toBeNull();
  });

  it('R127: a day status’s period counts add up', async () => {
    const insert = (recorded: number, present: number, absent: number) =>
      refusedBy(
        `INSERT INTO attendance_day_status (school_id, enrolment_id, student_id, section_id, date, status,
            periods_recorded, periods_present, periods_late, periods_absent, periods_leave)
         VALUES ($1, $2, $3, $4, '2026-09-17', 'partial', $5, $6, 0, $7, 0)`,
        [school.id, enrolments[0], students[0], section.id, recorded, present, absent],
      );
    expect(await insert(8, 7, 0)).toBe('attendance_day_status_periods_check');
    expect(await insert(0, 0, 0)).toBe('attendance_day_status_periods_check');
    expect(await insert(8, 7, 1)).toBeNull();
  });

  it('R134: nobody marks or amends their own staff attendance, principals included', async () => {
    const insert = (staffId: bigint, markedBy: bigint, date = '2026-09-18') =>
      `INSERT INTO staff_attendance (school_id, staff_id, date, status, marked_by)
       VALUES (${school.id}, ${staffId}, '${date}', 'present', ${markedBy}) RETURNING id`;
    expect(await refusedBy(insert(principal.staffId, principal.userId))).toBe('staff_attendance_not_self');
    expect(await refusedBy(insert(office.staffId, office.userId))).toBe('staff_attendance_not_self');
    const { id } = await run<{ id: string }>(insert(principal.staffId, office.userId));
    // Amending one's own row as the acting user is refused too, even when marked_by is someone else.
    await context(principal.userId, 'I was here');
    expect(await refusedBy(`UPDATE staff_attendance SET status = 'late' WHERE id = $1`, [id])).toBe(
      'staff_attendance_not_self',
    );
    await context(office.userId, 'Came in at 08:40');
    expect(await refusedBy(`UPDATE staff_attendance SET status = 'late' WHERE id = $1`, [id])).toBeNull();
  });

  it('R133: a staff status change needs an actor and a reason, is recorded, and the record is append-only', async () => {
    const { id } = await run<{ id: string }>(
      `INSERT INTO staff_attendance (school_id, staff_id, date, status, marked_by)
       VALUES ($1, $2, '2026-09-21', 'absent', $3) RETURNING id`,
      [school.id, teacher.staffId, office.userId],
    );
    const toLeave = `UPDATE staff_attendance SET status = 'on_leave' WHERE id = $1`;
    expect(await refusedBy(toLeave, [id])).toBe('staff_attendance_changes_actor_required');
    await context(office.userId);
    expect(await refusedBy(toLeave, [id])).toBe('staff_attendance_changes_reason_required');
    await context(office.userId, 'Leave approved late');
    await pg.query(toLeave, [id]);
    expect(
      await run(`SELECT old_status, new_status, reason FROM staff_attendance_changes WHERE staff_attendance_id = $1`, [id]),
    ).toEqual({ old_status: 'absent', new_status: 'on_leave', reason: 'Leave approved late' });
    expect(await refusedBy(`UPDATE staff_attendance_changes SET reason = 'x' WHERE staff_attendance_id = $1`, [id])).toBe(
      'staff_attendance_changes_append_only',
    );
    expect(await refusedBy(`UPDATE staff_attendance SET date = '2026-09-22' WHERE id = $1`, [id])).toBe(
      'staff_attendance_date_immutable',
    );
    expect(await refusedBy(`UPDATE staff_attendance SET marked_at = now() WHERE id = $1`, [id])).toBeNull();
  });
});
