// The wave N assessments and marks tables in the database (phase-4-academic.md §3.2, R261,
// R264, R265), and wave M's deferred TERM_IN_USE and CLASS_SUBJECT_IN_USE locks: no delete, no
// truncate, school_id immutable, frozen columns, the CHECKs, the partial uniques, the composite
// foreign keys and the triggers. Each statement is raw SQL inside one transaction that is rolled
// back, behind its own savepoint, so nothing here changes or removes a row even if a guard were
// missing (an exemption in guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createStudent, createSubject, day } from '../support/students';
import { createAssessment, createMark, createMarksFixture, entryKey, type MarksFixture } from './assessment-fixture';

const TABLES = ['assessments', 'marks'];

describe('wave N assessment and mark guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let f: MarksFixture;
  let otherSchoolId: bigint;
  let otherUserId: bigint;
  /** A weekly test (max 20) with one live mark. */
  let test: { id: bigint; maxMarks: number };
  let liveMark: bigint;
  let liveKey: string;
  /** An exam (max 100) with no mark. */
  let exam: { id: bigint; maxMarks: number };
  /** A locked test with one live absence. */
  let locked: { id: bigint; maxMarks: number };
  let absence: bigint;
  /** A voided test. */
  let voided: { id: bigint; maxMarks: number };
  let unusedSubject: bigint;

  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> =>
    refusedByAll([[sql, params]]);

  /** Runs the statements in order behind one savepoint; the first refusal's constraint, or null. */
  const refusedByAll = async (statements: [string, unknown[]][]): Promise<string | null> => {
    const savepoint = `guard_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      for (const [sql, params] of statements) await pg.query(sql, params);
      return null;
    } catch (error) {
      const e = error as DatabaseError;
      return e.constraint ?? e.detail?.replace(/^constraint: /, '') ?? e.message;
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  };

  /** As setup-guards: a TRUNCATE that waits on a busy table proves its guard from the catalogue. */
  const truncateRefused = async (table: string): Promise<string | null> => {
    const refusal = await refusedBy(`TRUNCATE ${table}`);
    if (refusal === null || !/lock timeout/i.test(refusal)) return refusal;
    const guard = await pg.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND (tgtype & 32) <> 0 AND NOT tgisinternal
       UNION ALL SELECT 1 FROM pg_constraint WHERE confrelid = $1::regclass AND contype = 'f' AND conrelid <> confrelid`,
      [table],
    );
    return (guard.rowCount ?? 0) > 0 ? `${table}: guarded (busy)` : null;
  };

  /** INSERT INTO marks with the fixture's enrolment; `cols` override or add columns. */
  const insertMark = (assessment: { id: bigint; maxMarks: number }, cols: Record<string, unknown> = {}): [string, unknown[]] => {
    const row: Record<string, unknown> = {
      school_id: f.school.id,
      assessment_id: assessment.id,
      enrolment_id: f.enrolmentId,
      student_id: f.studentId,
      academic_year_id: f.yearId,
      max_marks: assessment.maxMarks,
      obtained: 10,
      absent: false,
      status: 'live',
      entered_by: f.userId,
      client_entry_key: entryKey(),
      ...cols,
    };
    const names = Object.keys(row);
    return [
      `INSERT INTO marks (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    ];
  };

  /** INSERT INTO assessments of the fixture's section; `cols` override or add columns. */
  const insertAssessment = (cols: Record<string, unknown> = {}): [string, unknown[]] => {
    const row: Record<string, unknown> = {
      school_id: f.school.id,
      academic_year_id: f.yearId,
      term_id: f.midTermId,
      class_id: f.classId,
      section_id: f.sectionId,
      class_subject_id: f.classSubjectId,
      kind: 'test',
      test_type: 'daily',
      name: 'Quiz',
      max_marks: 10,
      held_on: '2026-05-20',
      created_by: f.userId,
      ...cols,
    };
    const names = Object.keys(row);
    return [
      `INSERT INTO assessments (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    ];
  };

  const supersede = (id: bigint): [string, unknown[]] => [
    `UPDATE marks SET status = 'superseded', superseded_at = now() WHERE school_id = $1 AND id = $2`,
    [f.school.id, id],
  ];

  beforeAll(async () => {
    const school = await createSchool();
    f = await createMarksFixture(school);
    const other = await createSchool();
    otherSchoolId = other.id;
    otherUserId = (await createSchoolUser(db, other, { systemRole: 'principal' })).userId;
    test = await createAssessment(f);
    liveKey = entryKey();
    liveMark = (await createMark(f, test, { clientEntryKey: liveKey })).id;
    exam = await createAssessment(f, { kind: 'exam', maxMarks: 100, heldOn: day('2026-09-20') });
    locked = await createAssessment(f, { name: 'Locked test' });
    absence = (await createMark(f, locked, { absent: true, obtained: null })).id;
    await db.assessment.updateMany({ where: { schoolId: f.school.id, id: locked.id }, data: { lockedAt: new Date() } });
    voided = await createAssessment(f, { name: 'Voided test' });
    await db.assessment.updateMany({
      where: { schoolId: f.school.id, id: voided.id },
      data: { voidedAt: new Date(), voidedBy: f.userId, voidReason: 'Set twice' },
    });
    unusedSubject = (
      await db.classSubject.create({
        data: {
          schoolId: f.school.id,
          academicYearId: f.yearId,
          classId: f.classId,
          subjectId: (await createSubject(db, school)).id,
          sortOrder: 2,
        },
      })
    ).id;
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

  it.each(TABLES)('%s: rows are never deleted or truncated, and school_id never changes', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [f.school.id])).toBe(`${table}_no_delete`);
    expect(await truncateRefused(table)).not.toBeNull();
    expect(await refusedBy(`UPDATE ${table} SET school_id = $1 WHERE school_id = $2`, [otherSchoolId, f.school.id])).toBe(
      `${table}_school_id_immutable`,
    );
  });

  it('assessments: clean name, max 1-1000, a test carries its type and an exam none, only a test locks, the void trio together', async () => {
    expect(await refusedBy(...insertAssessment({ name: ' Quiz' }))).toBe('assessments_name_check');
    expect(await refusedBy(...insertAssessment({ name: 'Quiz 35202-1234567-1' }))).toBe('assessments_name_no_id_check');
    expect(await refusedBy(...insertAssessment({ max_marks: 1001 }))).toBe('assessments_max_marks_check');
    expect(await refusedBy(...insertAssessment({ max_marks: 0 }))).toBe('assessments_max_marks_check');
    expect(await refusedBy(...insertAssessment({ test_type: null }))).toBe('assessments_test_type_check');
    expect(await refusedBy(...insertAssessment({ kind: 'exam', class_subject_id: unusedSubject }))).toBe('assessments_test_type_check');
    expect(await refusedBy(`UPDATE assessments SET locked_at = now() WHERE school_id = $1 AND id = $2`, [f.school.id, exam.id])).toBe(
      'assessments_locked_check',
    );
    expect(await refusedBy(`UPDATE assessments SET voided_at = now() WHERE school_id = $1 AND id = $2`, [f.school.id, exam.id])).toBe(
      'assessments_voided_check',
    );
    expect(
      await refusedBy(`UPDATE assessments SET voided_at = now(), voided_by = $3, void_reason = '35202-1234567-1' WHERE school_id = $1 AND id = $2`, [
        f.school.id,
        exam.id,
        f.userId,
      ]),
    ).toBe('assessments_void_reason_no_id_check');
    expect(await refusedBy(...insertAssessment())).toBeNull();
  });

  it('assessments: one live exam per section, class-subject and term; a voided exam frees the slot', async () => {
    expect(await refusedBy(...insertAssessment({ kind: 'exam', test_type: null, name: 'Again' }))).toBe('assessments_exam_key');
    expect(
      await refusedByAll([
        [`UPDATE assessments SET voided_at = now(), voided_by = $3, void_reason = 'Wrong max' WHERE school_id = $1 AND id = $2`, [f.school.id, exam.id, f.userId]],
        insertAssessment({ kind: 'exam', test_type: null, name: 'Again' }),
      ]),
    ).toBeNull();
    // Another term is another slot.
    expect(
      await refusedBy(...insertAssessment({ kind: 'exam', test_type: null, term_id: f.annualTermId, held_on: '2027-03-01' })),
    ).toBeNull();
  });

  it('R264: held_on lies inside the term, on insert and on change', async () => {
    expect(await refusedBy(...insertAssessment({ held_on: '2026-12-01' }))).toBe('assessments_held_on_in_term');
    expect(await refusedBy(`UPDATE assessments SET held_on = '2026-12-01' WHERE school_id = $1 AND id = $2`, [f.school.id, exam.id])).toBe(
      'assessments_held_on_in_term',
    );
    // A term of another year is refused by the composite foreign key (term and class share the year).
    expect(await refusedBy(...insertAssessment({ academic_year_id: f.yearId + 100000n }))).toMatch(/_fkey$/);
  });

  it('assessments: name, held_on and max change only while no mark exists; the facts, the lock and the void never change', async () => {
    expect(await refusedBy(`UPDATE assessments SET name = 'Renamed' WHERE school_id = $1 AND id = $2`, [f.school.id, test.id])).toBe(
      'assessments_has_marks',
    );
    expect(await refusedBy(`UPDATE assessments SET max_marks = 25 WHERE school_id = $1 AND id = $2`, [f.school.id, test.id])).toBe(
      'assessments_has_marks',
    );
    expect(await refusedBy(`UPDATE assessments SET held_on = '2026-05-11' WHERE school_id = $1 AND id = $2`, [f.school.id, test.id])).toBe(
      'assessments_has_marks',
    );
    expect(
      await refusedBy(`UPDATE assessments SET name = 'Renamed', max_marks = 50, held_on = '2026-06-01' WHERE school_id = $1 AND id = $2`, [
        f.school.id,
        exam.id,
      ]),
    ).toBeNull();
    expect(await refusedBy(`UPDATE assessments SET section_id = section_id + 1 WHERE school_id = $1 AND id = $2`, [f.school.id, exam.id])).toBe(
      'assessments_section_id_immutable',
    );
    expect(await refusedBy(`UPDATE assessments SET kind = 'test' WHERE school_id = $1 AND id = $2`, [f.school.id, exam.id])).toBe(
      'assessments_kind_immutable',
    );
    // Wave O (R269): locked_at is set once and never moved; a return clears it.
    expect(
      await refusedBy(`UPDATE assessments SET locked_at = locked_at + interval '1 hour' WHERE school_id = $1 AND id = $2`, [f.school.id, locked.id]),
    ).toBe('assessments_locked_at_frozen');
    expect(await refusedBy(`UPDATE assessments SET locked_at = NULL WHERE school_id = $1 AND id = $2`, [f.school.id, locked.id])).toBeNull();
    expect(
      await refusedBy(`UPDATE assessments SET voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE school_id = $1 AND id = $2`, [
        f.school.id,
        voided.id,
      ]),
    ).toBe('assessments_voided_at_frozen');
    expect(await refusedBy(`UPDATE assessments SET name = 'Renamed' WHERE school_id = $1 AND id = $2`, [f.school.id, voided.id])).toBe(
      'assessments_voided_frozen',
    );
    // The max is held a second way: the marks foreign key to (id, max_marks) is ON UPDATE RESTRICT.
    const fk = await pg.query<{ confupdtype: string }>(
      `SELECT confupdtype FROM pg_constraint WHERE conname = 'marks_assessment_max_fkey'`,
    );
    expect(fk.rows[0]?.confupdtype).toBe('r');
  });

  it('R261: a mark lies in 0..max, is a mark or an absence, is excused only when absent, and carries the assessment max', async () => {
    expect(await refusedBy(...insertMark(exam, { obtained: 101 }))).toBe('marks_obtained_check');
    expect(await refusedBy(...insertMark(exam, { obtained: -1 }))).toBe('marks_obtained_check');
    expect(await refusedBy(...insertMark(exam, { obtained: null }))).toBe('marks_absent_check');
    expect(await refusedBy(...insertMark(exam, { absent: true }))).toBe('marks_absent_check');
    expect(await refusedBy(...insertMark(test, { excused: true, supersedes_id: liveMark, correction_reason: 'Ill' }))).toBe(
      'marks_excused_check',
    );
    expect(await refusedBy(...insertMark(exam, { max_marks: 50 }))).toBe('marks_assessment_max_fkey');
    expect(await refusedBy(...insertMark(exam, { obtained: 100 }))).toBeNull();
    expect(await refusedBy(...insertMark(exam, { obtained: null, absent: true }))).toBeNull();
  });

  it('R261: a mark names its enrolment, student and year together, and supersedes only a mark of the same assessment and enrolment', async () => {
    const stranger = await createStudent(db, f.school, { admittedOn: '2026-04-01' });
    expect(await refusedBy(...insertMark(exam, { student_id: stranger.id }))).toBe('marks_enrolment_id_fkey');
    expect(['marks_assessment_id_fkey', 'marks_enrolment_id_fkey']).toContain(
      await refusedBy(...insertMark(exam, { academic_year_id: f.yearId + 100000n })),
    );
    expect(
      await refusedBy(...insertMark(exam, { supersedes_id: liveMark, correction_reason: null })),
    ).toBe('marks_supersedes_id_fkey');
  });

  it('marks: one live and one pending row per assessment and enrolment; a resend of a key finds its row', async () => {
    expect(await refusedBy(...insertMark(test))).toBe('marks_live_key');
    const pending = (cols: Record<string, unknown> = {}) =>
      insertMark(test, { status: 'pending', supersedes_id: liveMark, correction_reason: 'Added wrongly', ...cols });
    expect(await refusedByAll([pending(), pending()])).toBe('marks_pending_key');
    expect(await refusedBy(...pending({ client_entry_key: liveKey }))).toBe('marks_client_entry_key');
    expect(await refusedBy(...pending({ client_entry_key: null }))).toBeNull();
  });

  it('§3.8: the client entry key is 16-64 URL-safe characters and never a 13-digit run', async () => {
    expect(await refusedBy(...insertMark(exam, { client_entry_key: 'short' }))).toBe('marks_client_entry_key_check');
    expect(await refusedBy(...insertMark(exam, { client_entry_key: 'abc/def+ghi=jkl0000' }))).toBe('marks_client_entry_key_check');
    expect(await refusedBy(...insertMark(exam, { client_entry_key: 'key-3520212345671-x' }))).toBe('marks_client_entry_key_check');
    expect(await refusedBy(...insertMark(exam, { client_entry_key: 'key_0123456789ab-CD' }))).toBeNull();
  });

  it('marks: a reason only on a superseding row, always on a correction and an excusal; a plain re-entry needs none', async () => {
    expect(await refusedBy(...insertMark(exam, { correction_reason: 'Why' }))).toBe('marks_correction_check');
    expect(await refusedBy(...insertMark(test, { status: 'pending', supersedes_id: liveMark }))).toBe('marks_correction_check');
    expect(await refusedBy(...insertMark(test, { status: 'pending', supersedes_id: liveMark, correction_reason: ' Why' }))).toBe(
      'marks_correction_reason_check',
    );
    expect(
      await refusedBy(...insertMark(test, { status: 'pending', supersedes_id: liveMark, correction_reason: 'B-Form 3520212345671' })),
    ).toBe('marks_correction_reason_no_id_check');
    // A re-entry from the grid: the old row superseded, the new one live, no reason.
    expect(await refusedByAll([supersede(liveMark), insertMark(test, { obtained: 18, supersedes_id: liveMark })])).toBeNull();
    // An excusal needs its reason.
    expect(
      await refusedByAll([
        supersede(absence),
        insertMark(locked, { obtained: null, absent: true, excused: true, supersedes_id: absence }),
      ]),
    ).toBe('marks_correction_check');
  });

  it('marks: the chain is linear (a mark is superseded by at most one row that took effect)', async () => {
    expect(
      await refusedByAll([
        supersede(liveMark),
        insertMark(test, { obtained: 18, supersedes_id: liveMark, client_entry_key: 'first-entry-key-0001' }),
        [`UPDATE marks SET status = 'superseded', superseded_at = now() WHERE school_id = $1 AND client_entry_key = 'first-entry-key-0001'`, [f.school.id]],
        insertMark(test, { obtained: 19, supersedes_id: liveMark }),
      ]),
    ).toBe('marks_supersedes_key');
  });

  it('R261: a mark is never edited; only status, superseded_at and the decision move, along the allowed transitions', async () => {
    const where = [f.school.id, liveMark];
    expect(await refusedBy(`UPDATE marks SET obtained = 16 WHERE school_id = $1 AND id = $2`, where)).toBe('marks_obtained_immutable');
    expect(await refusedBy(`UPDATE marks SET absent = true, obtained = NULL WHERE school_id = $1 AND id = $2`, where)).toBe(
      'marks_obtained_immutable',
    );
    expect(await refusedBy(`UPDATE marks SET entered_by = $3 WHERE school_id = $1 AND id = $2`, [...where, f.userId + 1n])).toBe(
      'marks_entered_by_immutable',
    );
    expect(await refusedBy(`UPDATE marks SET status = 'pending' WHERE school_id = $1 AND id = $2`, where)).toBe('marks_status_transition');
    expect(await refusedBy(`UPDATE marks SET status = 'superseded' WHERE school_id = $1 AND id = $2`, where)).toBe('marks_superseded_check');
    expect(
      await refusedByAll([supersede(liveMark), [`UPDATE marks SET superseded_at = now() + interval '1 day' WHERE school_id = $1 AND id = $2`, where]]),
    ).toBe('marks_superseded_at_frozen');
    expect(await refusedByAll([supersede(liveMark), [`UPDATE marks SET status = 'live', superseded_at = NULL WHERE school_id = $1 AND id = $2`, where]])).toBe(
      'marks_status_transition',
    );
    expect(await refusedBy(...insertMark(exam, { status: 'superseded', superseded_at: new Date() }))).toBe('marks_born_live_or_pending');
  });

  it('marks: a correction is decided once (approve supersedes the old row; reject records the decider)', async () => {
    const correction = insertMark(test, {
      status: 'pending',
      supersedes_id: liveMark,
      correction_reason: 'Totalled wrongly',
      client_entry_key: 'correction-key-00001',
    });
    const byKey = `school_id = $1 AND client_entry_key = 'correction-key-00001'`;
    expect(await refusedBy(...insertMark(test, { status: 'pending', supersedes_id: liveMark, correction_reason: 'X', decided_by: f.userId, decided_at: new Date() }))).toBe(
      'marks_decided_check',
    );
    expect(await refusedByAll([correction, [`UPDATE marks SET status = 'rejected' WHERE ${byKey}`, [f.school.id]]])).toBe('marks_decided_check');
    expect(
      await refusedByAll([
        correction,
        supersede(liveMark),
        [`UPDATE marks SET status = 'live', decided_by = $2, decided_at = now() WHERE ${byKey}`, [f.school.id, f.userId]],
      ]),
    ).toBeNull();
    expect(
      await refusedByAll([
        correction,
        [`UPDATE marks SET status = 'rejected', decided_by = $2, decided_at = now() WHERE ${byKey}`, [f.school.id, f.userId]],
        [`UPDATE marks SET decided_at = now() + interval '1 day' WHERE ${byKey}`, [f.school.id]],
      ]),
    ).toBe('marks_decided_at_frozen');
    expect(
      await refusedByAll([
        correction,
        [`UPDATE marks SET status = 'rejected', decided_by = $2, decided_at = now() WHERE ${byKey}`, [f.school.id, f.userId]],
        [`UPDATE marks SET status = 'live' WHERE ${byKey}`, [f.school.id]],
      ]),
    ).toBe('marks_status_transition');
  });

  it('R281 (wave P review fixes): a correction made live is never decided by its author unless the sole principal; the author may withdraw it', async () => {
    const teacher = (await createSchoolUser(db, f.school, { systemRole: 'teacher' })).userId;
    const correction = insertMark(test, {
      status: 'pending',
      supersedes_id: liveMark,
      correction_reason: 'Totalled wrongly',
      entered_by: teacher,
      client_entry_key: 'correction-key-00002',
    });
    const byKey = `school_id = $1 AND client_entry_key = 'correction-key-00002'`;
    const decide = (status: 'live' | 'rejected', by: bigint): [string, unknown[]] => [
      `UPDATE marks SET status = '${status}', decided_by = $2, decided_at = now() WHERE ${byKey}`,
      [f.school.id, by],
    ];
    expect(await refusedByAll([correction, supersede(liveMark), decide('live', teacher)])).toBe('marks_not_self');
    // Withdrawn by its author (a rejection), or approved by someone else: allowed.
    expect(await refusedByAll([correction, decide('rejected', teacher)])).toBeNull();
    expect(await refusedByAll([correction, supersede(liveMark), decide('live', f.userId)])).toBeNull();
    // The sole principal's own correction (f.userId is the school's only principal): allowed.
    const own = insertMark(test, {
      status: 'pending',
      supersedes_id: liveMark,
      correction_reason: 'Totalled wrongly',
      client_entry_key: 'correction-key-00002',
    });
    expect(await refusedByAll([own, supersede(liveMark), decide('live', f.userId)])).toBeNull();
  });

  it('R265: a voided assessment takes no mark; a locked test takes no live mark, only a pending correction or an excusal', async () => {
    expect(await refusedBy(...insertMark(voided))).toBe('marks_assessment_voided');
    expect(await refusedByAll([supersede(absence), insertMark(locked, { obtained: 12, supersedes_id: absence })])).toBe('marks_assessment_locked');
    expect(
      await refusedBy(...insertMark(locked, { status: 'pending', obtained: 12, supersedes_id: absence, correction_reason: 'Was present' })),
    ).toBeNull();
    expect(
      await refusedByAll([
        supersede(absence),
        insertMark(locked, { obtained: null, absent: true, excused: true, supersedes_id: absence, correction_reason: 'Medical', entered_by: f.userId }),
      ]),
    ).toBeNull();
  });

  it('R254 (TERM_IN_USE): a term with a live assessment cannot change its dates or weight; its name can', async () => {
    const term = (set: string, id: bigint) =>
      refusedBy(`UPDATE academic_terms SET ${set} WHERE school_id = $1 AND id = $2`, [f.school.id, id]);
    expect(await term('weight = 60', f.midTermId)).toBe('academic_terms_in_use');
    expect(await term(`ends_on = '2026-09-29'`, f.midTermId)).toBe('academic_terms_in_use');
    expect(await term(`starts_on = '2026-04-02'`, f.midTermId)).toBe('academic_terms_in_use');
    expect(await term(`name = 'First term'`, f.midTermId)).toBeNull();
    expect(await term('weight = 40', f.annualTermId)).toBeNull();
  });

  it('R257 (CLASS_SUBJECT_IN_USE): a class subject with live marks cannot be archived; one without can', async () => {
    const archive = (id: bigint) =>
      refusedBy(`UPDATE class_subjects SET archived_at = now(), archived_by = $3 WHERE school_id = $1 AND id = $2`, [f.school.id, id, f.userId]);
    expect(await archive(f.classSubjectId)).toBe('class_subjects_in_use');
    expect(await archive(unusedSubject)).toBeNull();
  });

  it('refuses an assessment or mark in another school naming this school’s rows (composite foreign keys)', async () => {
    expect(await refusedBy(...insertAssessment({ school_id: otherSchoolId, created_by: otherUserId }))).toMatch(
      // The term is not found in that school, so the held-on trigger refuses before the foreign keys.
      /^assessments_(.*_fkey|held_on_in_term)$/,
    );
    expect(await refusedBy(...insertMark(exam, { school_id: otherSchoolId, entered_by: otherUserId }))).toMatch(/^marks_.*_fkey$/);
  });
});
