// The hand-written rules of the Phase 2 calendar migration (20261003184500_phase2_calendar_settings):
// holidays, cover assignments and the relaxed enrolment end date, driven with raw SQL inside one
// transaction that is rolled back, each statement behind its own savepoint.
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createStudent,
  createTeacherAssignment,
  enrol,
} from '../support/students';

describe('calendar schema rules (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let school: TestSchool;
  let principal: TestSchoolUser;
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

  const holiday = (startsOn: string, endsOn: string, name = 'Break') =>
    `INSERT INTO holidays (school_id, starts_on, ends_on, name, kind)
     VALUES (${school.id}, '${startsOn}', '${endsOn}', '${name}', 'school') RETURNING id`;

  beforeAll(async () => {
    school = await createSchool();
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
  });

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  it('live holidays never overlap; a cancelled one frees its dates', async () => {
    const { id } = await run<{ id: bigint }>(holiday('2026-12-20', '2026-12-31'));
    expect(await refusedBy(holiday('2026-12-31', '2027-01-02'))).toBe('holidays_live_excl');
    expect(await refusedBy(holiday('2027-01-01', '2027-01-02'))).toBeNull();
    expect(await refusedBy(holiday('2026-12-10', '2026-12-09'))).toBe('holidays_dates_check');
    await run(
      `UPDATE holidays SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
              cancel_reason = 'Moved' WHERE id = $1 RETURNING id`,
      [id, principal.userId],
    );
    expect(await refusedBy(holiday('2026-12-31', '2027-01-02'))).toBeNull();
    // Cancelled is final.
    expect(await refusedBy(`UPDATE holidays SET description = 'Back on' WHERE id = $1`, [id])).toBe(
      'holidays_description_frozen',
    );
  });

  it('R117: a published holiday’s dates, kind and name are frozen; its description is not', async () => {
    const { id } = await run<{ id: bigint }>(holiday('2027-03-23', '2027-03-23', 'Pakistan Day'));
    await run(
      `UPDATE holidays SET status = 'published', published_at = now(), published_by = $2
       WHERE id = $1 RETURNING id`,
      [id, principal.userId],
    );
    expect(await refusedBy(`UPDATE holidays SET ends_on = '2027-03-24' WHERE id = $1`, [id])).toBe(
      'holidays_ends_on_frozen',
    );
    expect(await refusedBy(`UPDATE holidays SET name = 'Renamed' WHERE id = $1`, [id])).toBe(
      'holidays_name_frozen',
    );
    expect(await refusedBy(`UPDATE holidays SET description = 'Closed for the day' WHERE id = $1`, [id])).toBeNull();
    expect(await refusedBy(`UPDATE holidays SET status = 'draft', published_at = NULL, published_by = NULL WHERE id = $1`, [id])).toBe(
      'holidays_published_at_frozen',
    );
  });

  it('R132: a cover names a section, no subject, an end date, and only a class-teacher row of its own section', async () => {
    const academics = await createClassWithSection(db, school);
    const other = await createClassWithSection(db, school);
    const classTeacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const coverTeacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const covered = await createTeacherAssignment(db, school, classTeacher, {
      role: 'class_teacher',
      section: academics.section,
    });
    const cover = (sectionId: bigint, endsOn: string | null, covers: bigint | null) =>
      refusedBy(
        `INSERT INTO teacher_assignments (school_id, staff_id, academic_year_id, class_id, section_id, role,
                                          starts_on, ends_on, covers_assignment_id)
         SELECT $1, $2, c.academic_year_id, c.id, $3, 'cover', CURRENT_DATE, $4::date, $5
         FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = $3`,
        [school.id, coverTeacher.staffId, sectionId, endsOn, covers],
      );
    expect(await cover(academics.section.id, null, covered.id)).toBe('teacher_assignments_cover_check');
    expect(await cover(other.section.id, '2099-01-01', covered.id)).toBe(
      'teacher_assignments_covers_assignment_id_fkey',
    );
    expect(await cover(academics.section.id, '2099-01-01', covered.id)).toBeNull();
    // Two class teachers' exclusion does not apply to a cover: it never displaces the class teacher.
    expect(await cover(academics.section.id, '2099-01-01', null)).toBeNull();
    // Only a cover names a covered row, and the link is frozen like the rest of the row.
    expect(
      await refusedBy(
        `INSERT INTO teacher_assignments (school_id, staff_id, academic_year_id, class_id, section_id, role,
                                          starts_on, covers_assignment_id)
         SELECT $1, $2, c.academic_year_id, c.id, $3, 'class_teacher', CURRENT_DATE, $4
         FROM sections s JOIN classes c ON c.id = s.class_id WHERE s.id = $3`,
        [school.id, coverTeacher.staffId, other.section.id, covered.id],
      ),
    ).toBe('teacher_assignments_covers_check');
    expect(
      await refusedBy(`UPDATE teacher_assignments SET covers_assignment_id = $2 WHERE id = $1`, [covered.id, covered.id]),
    ).toBe('teacher_assignments_covers_assignment_id_immutable');
  });

  it('a same-day section correction may close an enrolment on the day before it started', async () => {
    const academics = await createClassWithSection(db, school);
    const student = await createStudent(db, school);
    const enrolment = await enrol(db, school, student, academics.section);
    expect(
      await refusedBy(
        `UPDATE enrolments SET status = 'left', ended_on = started_on - 1 WHERE id = $1`,
        [enrolment.id],
      ),
    ).toBeNull();
    expect(
      await refusedBy(
        `UPDATE enrolments SET status = 'left', ended_on = started_on - 2 WHERE id = $1`,
        [enrolment.id],
      ),
    ).toBe('enrolments_ended_check');
  });
});
