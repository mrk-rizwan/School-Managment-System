// The hand-written rules of the wave-E diary and remark schema (migration
// 20261004120000_phase2_attendance_diary; contracts/slice-13.md §10): the diary's natural key,
// attachment and due-date CHECKs, frozen identity, the §4.6 history trigger with an optional
// reason, and the remark supersede chain. Raw SQL inside one transaction that is rolled back,
// each refused statement behind its own savepoint.
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createStudent,
  createSubject,
  enrol,
  type TestSection,
} from '../support/students';

const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

describe('diary and remark schema rules (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let school: TestSchool;
  let teacher: TestSchoolUser;
  let principal: TestSchoolUser;
  let section: TestSection;
  let subject: bigint;
  let otherSubject: bigint;
  let kids: { student: bigint; enrolment: bigint }[];
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

  const context = (actor: bigint | '' = '', reason = '') =>
    run(`SELECT set_config('asms.actor_user_id', $1, true), set_config('asms.change_reason', $2, true)`, [
      actor.toString(),
      reason,
    ]);

  /** INSERT of a diary entry; `extra` columns and values override the defaults. */
  const entry = (date: string, extra: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      school_id: school.id,
      section_id: section.id,
      class_id: section.classId,
      academic_year_id: section.academicYearId,
      date,
      subject_id: subject,
      author_staff_id: teacher.staffId,
      topic: 'Fractions',
      ...extra,
    };
    const columns = Object.keys(values);
    return {
      sql: `INSERT INTO diary_entries (${columns.join(', ')})
            VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      params: Object.values(values),
    };
  };

  const remark = (kid: { student: bigint; enrolment: bigint }, extra: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      school_id: school.id,
      enrolment_id: kid.enrolment,
      student_id: kid.student,
      author_staff_id: teacher.staffId,
      date: '2026-09-01',
      category: 'behaviour',
      text: 'Helped a classmate.',
      visibility: 'guardian',
      ...extra,
    };
    const columns = Object.keys(values);
    return {
      sql: `INSERT INTO remarks (${columns.join(', ')})
            VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      params: Object.values(values),
    };
  };

  beforeAll(async () => {
    school = await createSchool();
    teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    ({ section } = await createClassWithSection(db, school));
    subject = (await createSubject(db, school)).id;
    otherSubject = (await createSubject(db, school)).id;
    kids = [];
    for (let i = 0; i < 2; i++) {
      const student = await createStudent(db, school);
      kids.push({ student: student.id, enrolment: (await enrol(db, school, student, section)).id });
    }
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

  it('R137: one entry per section, date and subject', async () => {
    const first = entry('2026-09-01');
    await run(first.sql, first.params);
    expect(await refusedBy(first.sql, first.params)).toBe('diary_entries_natural_key');
    const other = entry('2026-09-01', { subject_id: otherSubject });
    expect(await refusedBy(other.sql, other.params)).toBeNull();
  });

  it('text, due date and attachment CHECKs (R139, contracts/slice-13.md §10 item 1)', async () => {
    const refused = (extra: Record<string, unknown>) => {
      const { sql, params } = entry('2026-09-02', extra);
      return refusedBy(sql, params);
    };
    expect(await refused({ topic: '  Fractions' })).toBe('diary_entries_topic_check');
    expect(await refused({ topic: 'CNIC 3520112345671' })).toBe('diary_entries_topic_no_id_check');
    expect(await refused({ assignment: 'B-Form 35201-1234567-1' })).toBe('diary_entries_assignment_no_id_check');
    expect(await refused({ due_on: '2026-09-01' })).toBe('diary_entries_due_on_check');
    expect(await refused({ due_on: '2026-09-02' })).toBeNull();
    expect(await refused({ attachment_object_key: `${school.id}/${ULID}.jpg` })).toBe(
      'diary_entries_attachment_check',
    );
    const attachment = (key: string, mime = 'image/jpeg', size = 1024) => ({
      attachment_object_key: key,
      attachment_mime: mime,
      attachment_size_bytes: size,
    });
    expect(await refused(attachment(`999999/${ULID}.jpg`))).toBe('diary_entries_attachment_check');
    expect(await refused(attachment(`${school.id}/${ULID}.jpg`, 'image/gif'))).toBe('diary_entries_attachment_check');
    expect(await refused(attachment(`${school.id}/${ULID}.pdf`, 'application/pdf', 6_000_000))).toBe(
      'diary_entries_attachment_check',
    );
    // A staged object is consumed once.
    const first = entry('2026-09-02', attachment(`${school.id}/${ULID}.png`, 'image/png'));
    await run(first.sql, first.params);
    expect(await refused({ subject_id: otherSubject, ...attachment(`${school.id}/${ULID}.png`, 'image/png') })).toBe(
      'diary_entries_attachment_object_key_key',
    );
  });

  it('a diary entry’s identity is frozen', async () => {
    const { sql, params } = entry('2026-09-03');
    const { id } = await run<{ id: string }>(sql, params);
    for (const [column, value] of [
      ['date', '2026-09-04'],
      ['subject_id', otherSubject],
      ['author_staff_id', principal.staffId],
    ] as const) {
      expect(await refusedBy(`UPDATE diary_entries SET ${column} = $2 WHERE id = $1`, [id, value])).toBe(
        `diary_entries_${column}_immutable`,
      );
    }
  });

  it('§4.6: an edit needs the acting user but not a reason, and records old and new values', async () => {
    const { sql, params } = entry('2026-09-07', { assignment: 'Exercise 3' });
    const { id } = await run<{ id: string }>(sql, params);
    const edit = `UPDATE diary_entries SET topic = 'Decimals', due_on = '2026-09-09', updated_at = now() WHERE id = $1`;
    expect(await refusedBy(edit, [id])).toBe('diary_entry_changes_actor_required');
    // A no-op (only updated_at) needs nothing and writes nothing.
    expect(await refusedBy(`UPDATE diary_entries SET updated_at = now() WHERE id = $1`, [id])).toBeNull();
    await context(teacher.userId);
    await pg.query(edit, [id]);
    expect(
      await run(
        `SELECT old_topic, new_topic, old_assignment, new_assignment, old_due_on::text, new_due_on::text,
                changed_by, reason FROM diary_entry_changes WHERE diary_entry_id = $1`,
        [id],
      ),
    ).toEqual({
      old_topic: 'Fractions',
      new_topic: 'Decimals',
      old_assignment: 'Exercise 3',
      new_assignment: 'Exercise 3',
      old_due_on: null,
      new_due_on: '2026-09-09',
      changed_by: teacher.userId.toString(),
      reason: null,
    });
    // After the window the service sends a reason; it is stored, and checked like any text.
    await context(principal.userId, 'Wrong chapter');
    await pg.query(`UPDATE diary_entries SET topic = 'Percentages' WHERE id = $1`, [id]);
    await context(principal.userId, 'CNIC 3520112345671');
    expect(await refusedBy(`UPDATE diary_entries SET topic = 'Ratios' WHERE id = $1`, [id])).toBe(
      'diary_entry_changes_reason_no_id_check',
    );
    expect(await refusedBy(`UPDATE diary_entry_changes SET reason = 'x' WHERE diary_entry_id = $1`, [id])).toBe(
      'diary_entry_changes_append_only',
    );
  });

  it('R141: a correction supersedes exactly one remark of the same child and carries its reason', async () => {
    const original = remark(kids[0]!);
    const { id } = await run<{ id: string }>(original.sql, original.params);
    // A correction needs a reason and an original needs none.
    const noReason = remark(kids[0]!, { supersedes_id: id, text: 'Helped two classmates.' });
    expect(await refusedBy(noReason.sql, noReason.params)).toBe('remarks_correction_check');
    const stray = remark(kids[0]!, { correction_reason: 'Typo' });
    expect(await refusedBy(stray.sql, stray.params)).toBe('remarks_correction_check');
    // Another child's remark cannot be superseded.
    const otherChild = remark(kids[1]!, { supersedes_id: id, correction_reason: 'Typo' });
    expect(await refusedBy(otherChild.sql, otherChild.params)).toBe('remarks_supersedes_id_fkey');

    const correction = remark(kids[0]!, {
      supersedes_id: id,
      text: 'Helped two classmates.',
      correction_reason: 'Typo',
      author_staff_id: principal.staffId,
    });
    const successor = await run<{ id: string }>(correction.sql, correction.params);
    const stamped = await run<{ superseded_at: Date | null }>(
      `SELECT superseded_at FROM remarks WHERE id = $1`,
      [id],
    );
    expect(stamped.superseded_at).not.toBeNull();
    // A chain, never a tree.
    expect(await refusedBy(correction.sql, correction.params)).toBe('remarks_supersedes_id_key');
    // The successor itself may be corrected in turn.
    const next = remark(kids[0]!, { supersedes_id: successor.id, correction_reason: 'Again' });
    expect(await refusedBy(next.sql, next.params)).toBeNull();
    // Once set, superseded_at never moves.
    expect(await refusedBy(`UPDATE remarks SET superseded_at = now() + interval '1 day' WHERE id = $1`, [id])).toBe(
      'remarks_superseded_at_frozen',
    );
  });

  it('R141: a remark is never edited, and only a successor marks it superseded', async () => {
    const { sql, params } = remark(kids[1]!);
    const { id } = await run<{ id: string }>(sql, params);
    expect(await refusedBy(`UPDATE remarks SET text = 'Edited' WHERE id = $1`, [id])).toBe('remarks_text_immutable');
    expect(await refusedBy(`UPDATE remarks SET visibility = 'internal' WHERE id = $1`, [id])).toBe(
      'remarks_visibility_immutable',
    );
    expect(await refusedBy(`UPDATE remarks SET superseded_at = now() WHERE id = $1`, [id])).toBe(
      'remarks_superseded_by_successor',
    );
    const born = remark(kids[1]!, { superseded_at: new Date() });
    expect(await refusedBy(born.sql, born.params)).toBe('remarks_superseded_by_successor');
    const self = remark(kids[1]!, { id, supersedes_id: id, correction_reason: 'Self' });
    expect(await refusedBy(self.sql, self.params)).toBe('remarks_supersedes_self_check');
    const text = remark(kids[1]!, { text: 'Father CNIC 35201-1234567-1' });
    expect(await refusedBy(text.sql, text.params)).toBe('remarks_text_no_id_check');
    // The enrolment and the child must agree.
    const mismatch = remark({ enrolment: kids[0]!.enrolment, student: kids[1]!.student });
    expect(await refusedBy(mismatch.sql, mismatch.params)).toBe('remarks_enrolment_id_fkey');
  });
});
