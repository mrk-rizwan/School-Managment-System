// The wave O tables in the database (phase-4-academic.md §3.2, R256, R257, R265, R267-R271) and
// the wave-O deferrals of waves M and N: no delete, no truncate, school_id immutable, the
// CHECKs, the open and live partial uniques, the status edges, the approver rule, the snapshot
// freeze, the remark window, the result insert guard, the settings and term locks, the
// class-subject freeze and in-use rule, and the sheet half of the assessment lock. Each statement
// is raw SQL inside one transaction that is rolled back, behind its own savepoint (an exemption in
// guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createSubject } from '../support/students';
import {
  createAssessment,
  createMarksFixture,
  entryKey,
  type MarksFixture,
} from '../academics/assessment-fixture';
import { BANDS, createResult, createSheet, moveSheet } from './fixture';

const TABLES = ['result_sheets', 'result_sheet_remarks', 'results', 'result_subjects'];

describe('wave O result sheet guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  /** A published Mid-term sheet with one result. */
  let pub: MarksFixture;
  let pubSheet: bigint;
  let pubResult: bigint;
  /** The second principal who decided pub's sheet. */
  let pubDecider: bigint;
  /** A submitted Mid-term sheet, an exam and a test of that section-term. */
  let sub: MarksFixture;
  let subSheet: bigint;
  /** The second principal who may decide sub's sheet. */
  let subDecider: bigint;
  let subExam: { id: bigint; maxMarks: number };
  let subTest: { id: bigint; maxMarks: number };
  /** A draft sheet. */
  let draft: MarksFixture;
  let draftSheet: bigint;
  let otherSchoolId: bigint;

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
      `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND (tgtype & 32) <> 0 AND NOT tgisinternal
       UNION ALL SELECT 1 FROM pg_constraint WHERE confrelid = $1::regclass AND contype = 'f' AND conrelid <> confrelid`,
      [table],
    );
    return (guard.rowCount ?? 0) > 0 ? `${table}: guarded (busy)` : null;
  };

  const insert = (table: string, row: Record<string, unknown>): [string, unknown[]] => {
    const names = Object.keys(row);
    return [
      `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    ];
  };
  const sheetRow = (f: MarksFixture, cols: Record<string, unknown> = {}) =>
    insert('result_sheets', {
      school_id: f.school.id,
      academic_year_id: f.yearId,
      term_id: f.midTermId,
      class_id: f.classId,
      section_id: f.sectionId,
      created_by: f.userId,
      ...cols,
    });
  const resultRow = (f: MarksFixture, sheetId: bigint, cols: Record<string, unknown> = {}) =>
    insert('results', {
      school_id: f.school.id,
      sheet_id: sheetId,
      enrolment_id: f.enrolmentId,
      student_id: f.studentId,
      academic_year_id: f.yearId,
      term_id: f.midTermId,
      total_obtained: 50,
      total_max: 100,
      percent_bp: 5000,
      grade: 'F',
      passed: true,
      ...cols,
    });
  const subjectRow = (cols: Record<string, unknown> = {}) =>
    insert('result_subjects', {
      school_id: pub.school.id,
      result_id: pubResult,
      class_id: pub.classId,
      class_subject_id: pub.classSubjectId,
      subject_name: 'Science',
      sort_order: 2,
      percent_bp: 5000,
      obtained: 50,
      max: 100,
      grade: 'F',
      status: 'assessed',
      ...cols,
    });
  const sheetUpdate = (f: MarksFixture, id: bigint, set: string) =>
    refusedBy(`UPDATE result_sheets SET ${set} WHERE school_id = $1 AND id = $2`, [
      f.school.id,
      id,
    ]);

  beforeAll(async () => {
    pub = await createMarksFixture(await createSchool());
    pubSheet = (await createSheet(pub)).id;
    await db.resultSheetRemark.create({
      data: {
        schoolId: pub.school.id,
        sheetId: pubSheet,
        enrolmentId: pub.enrolmentId,
        remark: 'Works well.',
        writtenBy: pub.userId,
      },
    });
    pubDecider = await moveSheet(pub, pubSheet, 'approved');
    pubResult = (await createResult(pub, pubSheet)).id;
    await db.resultSheet.updateMany({
      where: { schoolId: pub.school.id, id: pubSheet },
      data: { status: 'published', publishedBy: pub.userId, publishedAt: new Date() },
    });
    await db.result.updateMany({
      where: { schoolId: pub.school.id, id: pubResult },
      data: { publishedAt: new Date() },
    });

    sub = await createMarksFixture(await createSchool());
    subExam = await createAssessment(sub, { kind: 'exam', maxMarks: 100 });
    subTest = await createAssessment(sub);
    subSheet = (await createSheet(sub)).id;
    subDecider = await moveSheet(sub, subSheet, 'submitted');

    draft = await createMarksFixture(await createSchool());
    draftSheet = (await createSheet(draft)).id;
    otherSchoolId = (await createSchool()).id;

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

  it.each(TABLES)(
    '%s: rows are never deleted or truncated, and school_id never changes',
    async (table) => {
      expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [pub.school.id])).toBe(
        `${table}_no_delete`,
      );
      expect(await truncateRefused(table)).not.toBeNull();
      // A remark on a published sheet also meets result_sheet_remarks_open, which fires first.
      expect(
        await refusedBy(`UPDATE ${table} SET school_id = $1 WHERE school_id = $2`, [
          otherSchoolId,
          pub.school.id,
        ]),
      ).toMatch(new RegExp(`^${table}_(school_id_immutable|open)$`));
    },
  );

  it('R267: a sheet is born draft, one open version per section and term, versions numbered from 1', async () => {
    expect(await refusedBy(...sheetRow(draft, { status: 'submitted' }))).toBe(
      'result_sheets_born_draft',
    );
    expect(await refusedBy(...sheetRow(draft))).toBe('result_sheets_open_key');
    expect(await refusedBy(...sheetRow(draft, { version: 2 }))).toBe('result_sheets_version_check');
    // Another term, and the final sheet, are other slots.
    expect(await refusedBy(...sheetRow(draft, { term_id: draft.annualTermId }))).toBeNull();
    expect(await refusedBy(...sheetRow(draft, { term_id: null }))).toBeNull();
    // A published version leaves the slot free for the next open one (slice 32's correction).
    expect(
      await refusedBy(
        ...sheetRow(pub, { version: 2, status: 'published', supersedes_id: pubSheet }),
      ),
    ).toMatch(/^result_sheets_(published_check|snapshot_check|decided_check)$/);
  });

  it('§3.2: the status moves only along the six edges; a decision is recorded exactly while decided', async () => {
    expect(
      await sheetUpdate(
        draft,
        draftSheet,
        `status = 'approved', decided_by = created_by, decided_at = now()`,
      ),
    ).toBe('result_sheets_status_transition');
    expect(await sheetUpdate(pub, pubSheet, `status = 'approved'`)).toBe(
      'result_sheets_status_transition',
    );
    expect(await sheetUpdate(sub, subSheet, `status = 'returned'`)).toBe(
      'result_sheets_decided_check',
    );
    expect(
      await sheetUpdate(
        sub,
        subSheet,
        `status = 'returned', decided_by = ${subDecider}, decided_at = now()`,
      ),
    ).toBe('result_sheets_return_reason_check');
    expect(
      await sheetUpdate(
        sub,
        subSheet,
        `status = 'returned', decided_by = ${subDecider}, decided_at = now(), return_reason = 'Ask 35202-1234567-1'`,
      ),
    ).toBe('result_sheets_return_reason_no_id_check');
  });

  it('R271: the submitter never decides (two principals); self_approved only by the sole principal', async () => {
    expect(
      await sheetUpdate(
        sub,
        subSheet,
        `status = 'returned', decided_by = submitted_by, decided_at = now(), return_reason = 'Check'`,
      ),
    ).toBe('result_sheets_not_self');
    expect(
      await sheetUpdate(
        sub,
        subSheet,
        `status = 'approved', decided_by = submitted_by, decided_at = now(), self_approved = true, test_weight = 20, exam_weight = 80, pass_percent = 40, pass_rule = 'all_subjects', bands = '[]'`,
      ),
    ).toBe('result_sheets_not_self');
  });

  it('R281 (wave P review fixes): the version of a correction is born decided by someone other than its submitter, unless the sole principal records self_approved', async () => {
    const version = (cols: Record<string, unknown>) =>
      sheetRow(pub, {
        version: 2,
        status: 'published',
        supersedes_id: pubSheet,
        submitted_by: pub.userId,
        submitted_at: new Date(),
        decided_at: new Date(),
        published_by: pubDecider,
        published_at: new Date(),
        test_weight: 20,
        exam_weight: 80,
        pass_percent: 40,
        pass_rule: 'all_subjects',
        bands: JSON.stringify(BANDS),
        ...cols,
      });
    // Two principals: the submitter may not decide the version, even claiming self_approved.
    expect(await refusedBy(...version({ decided_by: pub.userId }))).toBe('result_sheets_not_self');
    expect(await refusedBy(...version({ decided_by: pub.userId, self_approved: true }))).toBe('result_sheets_not_self');
    // Another person decides it; self_approved is then unwarranted.
    expect(await refusedBy(...version({ decided_by: pubDecider, self_approved: true }))).toBe(
      'result_sheets_self_approved_unwarranted',
    );
    expect(await refusedBy(...version({ decided_by: pubDecider }))).toBeNull();
  });

  it('R256: the snapshot is whole once approved and frozen while approved or published; publication is frozen', async () => {
    expect(
      await sheetUpdate(
        sub,
        subSheet,
        `status = 'approved', decided_by = created_by, decided_at = now()`,
      ),
    ).toMatch(/^result_sheets_(snapshot_check|not_self)$/);
    expect(await sheetUpdate(pub, pubSheet, `pass_percent = 33`)).toBe(
      'result_sheets_pass_percent_frozen',
    );
    expect(await sheetUpdate(pub, pubSheet, `published_at = now() - interval '1 day'`)).toBe(
      'result_sheets_published_at_frozen',
    );
    expect(await sheetUpdate(pub, pubSheet, `section_id = section_id + 1`)).toBe(
      'result_sheets_section_id_immutable',
    );
    expect(await sheetUpdate(draft, draftSheet, `test_weight = 30, exam_weight = 80`)).toBe(
      'result_sheets_snapshot_check',
    );
  });

  it('remarks: written only while the sheet is draft or returned; clean text, no identity number', async () => {
    const remark = (f: MarksFixture, sheetId: bigint, text: string | null) =>
      insert('result_sheet_remarks', {
        school_id: f.school.id,
        sheet_id: sheetId,
        enrolment_id: f.enrolmentId,
        remark: text,
        written_by: f.userId,
      });
    expect(await refusedBy(...remark(sub, subSheet, 'Good'))).toBe('result_sheet_remarks_open');
    expect(await refusedBy(...remark(pub, pubSheet, 'Good'))).toBe('result_sheet_remarks_open');
    expect(await refusedBy(...remark(draft, draftSheet, ' Good'))).toBe(
      'result_sheet_remarks_remark_check',
    );
    expect(await refusedBy(...remark(draft, draftSheet, 'Ask 35202-1234567-1'))).toBe(
      'result_sheet_remarks_remark_no_id_check',
    );
    expect(await refusedBy(...remark(draft, draftSheet, null))).toBeNull();
    expect(await refusedBy(...remark(draft, draftSheet, 'Good'))).toBeNull();
  });

  it('results: only onto an approved sheet, one live per enrolment and term, consistent figures, frozen', async () => {
    expect(await refusedBy(...resultRow(draft, draftSheet))).toBe('results_sheet_approved');
    expect(await refusedBy(...resultRow(sub, subSheet))).toBe('results_sheet_approved');
    expect(await refusedBy(...resultRow(pub, pubSheet))).toMatch(
      /^results_(live_key|sheet_enrolment_key)$/,
    );
    expect(await refusedBy(...resultRow(pub, pubSheet, { percent_bp: 10001 }))).toBe(
      'results_percent_check',
    );
    expect(await refusedBy(...resultRow(pub, pubSheet, { percent_bp: null }))).toBe(
      'results_assessed_check',
    );
    expect(await refusedBy(...resultRow(pub, pubSheet, { position: 2, position_of: 1 }))).toBe(
      'results_position_check',
    );
    expect(await refusedBy(...resultRow(pub, pubSheet, { total_obtained: 101 }))).toBe(
      'results_totals_check',
    );
    expect(await refusedBy(...resultRow(pub, pubSheet, { remark: 'Call 35202-1234567-1' }))).toBe(
      'results_remark_no_id_check',
    );
    expect(await refusedBy(...resultRow(pub, pubSheet, { own_child_flags: '{}' }))).toBe(
      'results_own_child_flags_check',
    );
    const upd = (set: string) =>
      refusedBy(`UPDATE results SET ${set} WHERE school_id = $1 AND id = $2`, [
        pub.school.id,
        pubResult,
      ]);
    expect(await upd('percent_bp = 9000')).toBe('results_percent_bp_immutable');
    expect(await upd(`published_at = now() - interval '1 day'`)).toBe(
      'results_published_at_frozen',
    );
    expect(await upd('notified_at = now()')).toBeNull();
    expect(await upd('superseded_at = now()')).toBeNull();
  });

  it('result_subjects: not_assessed iff no percentage, the exam as met, frozen', async () => {
    expect(await refusedBy(...subjectRow({ status: 'not_assessed' }))).toBe(
      'result_subjects_status_check',
    );
    expect(await refusedBy(...subjectRow({ obtained: 101 }))).toBe('result_subjects_marks_check');
    expect(await refusedBy(...subjectRow({ exam_absent: true }))).toBe(
      'result_subjects_exam_check',
    );
    expect(
      await refusedBy(...subjectRow({ exam_max: 100, exam_obtained: 70, exam_absent: true })),
    ).toBe('result_subjects_exam_check');
    expect(await refusedBy(...subjectRow({ exam_max: 100, exam_obtained: null }))).toBe(
      'result_subjects_exam_check',
    );
    expect(await refusedBy(...subjectRow({ class_subject_id: pub.classSubjectId }))).toMatch(
      /result_subjects_school_id_result_id_class_subject_id_key/,
    );
    expect(
      await refusedBy(
        `UPDATE result_subjects SET percent_bp = 1 WHERE school_id = $1 AND result_id = $2`,
        [pub.school.id, pubResult],
      ),
    ).toBe('result_subjects_percent_bp_immutable');
  });

  it('R256: the year’s composition settings and its terms freeze once a sheet is approved; the toggles do not', async () => {
    const settings = (set: string, f: MarksFixture) =>
      refusedBy(
        `UPDATE result_settings SET ${set} WHERE school_id = $1 AND academic_year_id = $2`,
        [f.school.id, f.yearId],
      );
    expect(await settings('pass_percent = 33', pub)).toBe('result_settings_locked');
    expect(await settings(`bands = '[{"grade":"P","minPercent":0}]'`, pub)).toBe(
      'result_settings_locked',
    );
    expect(await settings('show_position = false', pub)).toBeNull();
    expect(await settings('pass_percent = 33', sub)).toBeNull();
    expect(
      await refusedBy(`UPDATE academic_terms SET weight = 40 WHERE school_id = $1 AND id = $2`, [
        pub.school.id,
        pub.annualTermId,
      ]),
    ).toBe('academic_terms_results_locked');
    expect(
      await refusedBy(
        `INSERT INTO academic_terms (school_id, academic_year_id, name, sort_order, starts_on, ends_on, weight) VALUES ($1, $2, 'Third', 3, '2026-04-01', '2026-04-01', 0)`,
        [pub.school.id, pub.yearId],
      ),
    ).toBe('academic_terms_results_locked');
  });

  it('TERM_IN_USE: a term with a submitted sheet keeps its dates and weight', async () => {
    expect(
      await refusedBy(`UPDATE academic_terms SET weight = 40 WHERE school_id = $1 AND id = $2`, [
        sub.school.id,
        sub.midTermId,
      ]),
    ).toBe('academic_terms_in_use');
  });

  it('R257: the subject list is frozen while a sheet is under review; a subject on a published result is in use', async () => {
    const subject = await createSubject(db, sub.school);
    expect(
      await refusedBy(
        `INSERT INTO class_subjects (school_id, academic_year_id, class_id, subject_id, sort_order) VALUES ($1, $2, $3, $4, 9)`,
        [sub.school.id, sub.yearId, sub.classId, subject.id],
      ),
    ).toBe('class_subjects_frozen');
    expect(
      await refusedBy(`UPDATE class_subjects SET sort_order = 7 WHERE school_id = $1 AND id = $2`, [
        sub.school.id,
        sub.classSubjectId,
      ]),
    ).toBe('class_subjects_frozen');
    expect(
      await refusedBy(
        `UPDATE class_subjects SET archived_at = now(), archived_by = $3 WHERE school_id = $1 AND id = $2`,
        [pub.school.id, pub.classSubjectId, pub.userId],
      ),
    ).toBe('class_subjects_in_use');
  });

  it('R265: a section-term sheet submitted or later locks its assessments: no live mark, no new assessment, no void', async () => {
    const mark = (assessment: { id: bigint; maxMarks: number }) =>
      insert('marks', {
        school_id: sub.school.id,
        assessment_id: assessment.id,
        enrolment_id: sub.enrolmentId,
        student_id: sub.studentId,
        academic_year_id: sub.yearId,
        max_marks: assessment.maxMarks,
        obtained: 10,
        absent: false,
        status: 'live',
        entered_by: sub.userId,
        client_entry_key: entryKey(),
      });
    expect(await refusedBy(...mark(subExam))).toBe('marks_assessment_locked');
    expect(await refusedBy(...mark(subTest))).toBe('marks_assessment_locked');
    expect(
      await refusedBy(
        ...insert('assessments', {
          school_id: sub.school.id,
          academic_year_id: sub.yearId,
          term_id: sub.midTermId,
          class_id: sub.classId,
          section_id: sub.sectionId,
          class_subject_id: sub.classSubjectId,
          kind: 'test',
          test_type: 'daily',
          name: 'Quiz',
          max_marks: 10,
          held_on: '2026-05-20',
          created_by: sub.userId,
        }),
      ),
    ).toBe('assessments_sheet_not_draft');
    expect(
      await refusedBy(
        `UPDATE assessments SET voided_at = now(), voided_by = $3, void_reason = 'Twice' WHERE school_id = $1 AND id = $2`,
        [sub.school.id, subExam.id, sub.userId],
      ),
    ).toBe('assessments_void_locked');
    // A draft sheet locks nothing.
    const free = await createAssessment(draft, { kind: 'exam', maxMarks: 100 });
    expect(
      await refusedBy(
        ...insert('marks', {
          school_id: draft.school.id,
          assessment_id: free.id,
          enrolment_id: draft.enrolmentId,
          student_id: draft.studentId,
          academic_year_id: draft.yearId,
          max_marks: 100,
          obtained: 10,
          absent: false,
          status: 'live',
          entered_by: draft.userId,
          client_entry_key: entryKey(),
        }),
      ),
    ).toBeNull();
  });

  it('§2.4: the submission record is written only by the draft | returned → submitted edge', async () => {
    for (const set of [
      `submitted_by = ${subDecider}`,
      'submitted_at = now()',
      `submitted_under_assignment_id = NULL, submitted_by = NULL`,
    ]) {
      expect(await sheetUpdate(sub, subSheet, set)).toBe('result_sheets_submission_frozen');
    }
    // A draft's (or a returned sheet's) submission writes it.
    expect(
      await sheetUpdate(
        draft,
        draftSheet,
        `status = 'submitted', submitted_by = ${draft.userId}, submitted_at = now()`,
      ),
    ).toBeNull();
  });

  it('§2.4: result_sheet_locks — onto a submitted term sheet, a test of its class-term, released only once returned, never deleted', async () => {
    const lock = (f: MarksFixture, sheetId: bigint, cols: Record<string, unknown>) =>
      insert('result_sheet_locks', { school_id: f.school.id, sheet_id: sheetId, ...cols });
    // A draft sheet takes none.
    expect(await refusedBy(...lock(draft, draftSheet, { student_id: draft.studentId }))).toBe(
      'result_sheet_locks_sheet_submitted',
    );
    // Exactly one target.
    expect(
      await refusedBy(
        ...lock(sub, subSheet, { student_id: sub.studentId, assessment_id: subTest.id }),
      ),
    ).toBe('result_sheet_locks_target_check');
    // A test, not an exam.
    expect(await refusedBy(...lock(sub, subSheet, { assessment_id: subExam.id }))).toBe(
      'result_sheet_locks_test_of_class_term',
    );
    // Written onto the submitted sheet, then: one unreleased row per target, no release while
    // the sheet is submitted, no delete, school_id fixed.
    await pg.query('SAVEPOINT locks');
    try {
      await pg.query(...lock(sub, subSheet, { student_id: sub.studentId }));
      await pg.query(...lock(sub, subSheet, { assessment_id: subTest.id }));
      expect(await refusedBy(...lock(sub, subSheet, { student_id: sub.studentId }))).toBe(
        'result_sheet_locks_open_student_key',
      );
      const where = [sub.school.id, subSheet];
      expect(
        await refusedBy(
          'UPDATE result_sheet_locks SET released_at = now() WHERE school_id = $1 AND sheet_id = $2',
          where,
        ),
      ).toBe('result_sheet_locks_release_returned');
      expect(
        await refusedBy(
          'DELETE FROM result_sheet_locks WHERE school_id = $1 AND sheet_id = $2',
          where,
        ),
      ).toBe('result_sheet_locks_no_delete');
      expect(
        await refusedBy(
          'UPDATE result_sheet_locks SET school_id = $3 WHERE school_id = $1 AND sheet_id = $2',
          [...where, otherSchoolId],
        ),
      ).toMatch(/^result_sheet_locks_(school_id_immutable|.*_fkey)$/);
      expect(await truncateRefused('result_sheet_locks')).not.toBeNull();
    } finally {
      await pg.query('ROLLBACK TO SAVEPOINT locks');
    }
  });

  it('refuses rows in another school naming this school’s sheet (composite foreign keys)', async () => {
    expect(await refusedBy(...resultRow(pub, pubSheet, { school_id: otherSchoolId }))).toMatch(
      /^results_(.*_fkey|sheet_approved)$/,
    );
    expect(
      await refusedBy(
        ...insert('result_sheet_remarks', {
          school_id: otherSchoolId,
          sheet_id: draftSheet,
          enrolment_id: draft.enrolmentId,
          remark: 'x',
          written_by: draft.userId,
        }),
      ),
    ).toMatch(/^result_sheet_remarks_(.*_fkey|open)$/);
  });
});
