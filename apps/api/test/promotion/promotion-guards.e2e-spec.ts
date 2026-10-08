// The wave P tables in the database (phase-4-academic.md §3.2 "Promotion", "Enrolments and
// students"; contracts/slice-35.md §6): no delete, no truncate, school_id immutable, the CHECKs,
// the open partial unique, the one status edge, the columns frozen, rows written only while the
// sheet is open and only for an enrolment of its section, an applied row frozen but for
// revised_after_apply, the composite foreign keys, and the enrolment status edges. Each statement
// is raw SQL inside one transaction that is rolled back, behind its own savepoint (an exemption in
// guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { createMarksFixture, type MarksFixture } from '../academics/assessment-fixture';
import { createResult, createSheet, moveSheet } from '../results/fixture';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, enrol } from '../support/students';

const TABLES = ['promotion_sheets', 'promotion_decisions'];

describe('wave P promotion guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let f: MarksFixture;
  let targetYearId: bigint;
  let targetClassId: bigint;
  let targetSectionId: bigint;
  /** A class of f's own year (not the target year). */
  let otherYearClassId: bigint;
  let openSheet: bigint;
  /** f's row on the open sheet: proposed promote, undecided, reading f's mid-term result. */
  let openRow: bigint;
  let resultId: bigint;
  /** A second section of f's class, its pupil, and its applied sheet with one applied row. */
  let otherSectionId: bigint;
  let otherEnrolmentId: bigint;
  let otherStudentId: bigint;
  let appliedSheet: bigint;
  let appliedRow: bigint;
  /** A second pupil of f's section, not yet on the open sheet. */
  let secondEnrolmentId: bigint;
  let secondStudentId: bigint;
  /** A left enrolment of f's student (an earlier section). */
  let leftEnrolmentId: bigint;
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
      `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND (tgtype & 32) <> 0 AND NOT tgisinternal`,
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
  const sheetRow = (cols: Record<string, unknown> = {}) =>
    insert('promotion_sheets', {
      school_id: f.school.id,
      academic_year_id: f.yearId,
      class_id: f.classId,
      section_id: otherSectionId,
      target_year_id: targetYearId,
      opened_by: f.userId,
      ...cols,
    });
  const decisionRow = (cols: Record<string, unknown> = {}) =>
    insert('promotion_decisions', {
      school_id: f.school.id,
      sheet_id: openSheet,
      target_year_id: targetYearId,
      enrolment_id: f.enrolmentId,
      student_id: f.studentId,
      ...cols,
    });
  const updateRow = (id: bigint, set: string, params: unknown[] = []) =>
    refusedBy(`UPDATE promotion_decisions SET ${set} WHERE school_id = $1 AND id = $2`, [f.school.id, id, ...params]);
  const updateSheet = (id: bigint, set: string, params: unknown[] = []) =>
    refusedBy(`UPDATE promotion_sheets SET ${set} WHERE school_id = $1 AND id = $2`, [f.school.id, id, ...params]);

  beforeAll(async () => {
    f = await createMarksFixture(await createSchool());
    const where = { schoolId: f.school.id };
    const target = await createAcademicYear(db, f.school, { startsOn: '2027-04-01', endsOn: '2028-03-31', status: 'planned' });
    targetYearId = target.id;
    const targetClass = await createClass(db, f.school, target);
    targetClassId = targetClass.id;
    targetSectionId = (await createSection(db, f.school, targetClass)).id;
    otherYearClassId = (await createClass(db, f.school, { id: f.yearId })).id;

    const sheet = await createSheet(f);
    await moveSheet(f, sheet.id, 'approved');
    resultId = (await createResult(f, sheet.id)).id;

    openSheet = (
      await db.promotionSheet.create({
        data: { ...where, academicYearId: f.yearId, classId: f.classId, sectionId: f.sectionId, targetYearId, openedBy: f.userId },
      })
    ).id;
    openRow = (
      await db.promotionDecision.create({
        data: {
          ...where,
          sheetId: openSheet,
          targetYearId,
          enrolmentId: f.enrolmentId,
          studentId: f.studentId,
          resultId,
          proposed: 'promote',
        },
      })
    ).id;

    const otherSection = await createSection(db, f.school, { id: f.classId, academicYearId: f.yearId });
    otherSectionId = otherSection.id;
    const other = await createStudent(db, f.school, { admittedOn: '2026-04-01' });
    otherStudentId = other.id;
    otherEnrolmentId = (await enrol(db, f.school, other, otherSection, { startedOn: '2026-04-01' })).id;
    appliedSheet = (
      await db.promotionSheet.create({
        data: { ...where, academicYearId: f.yearId, classId: f.classId, sectionId: otherSectionId, targetYearId, openedBy: f.userId },
      })
    ).id;
    appliedRow = (
      await db.promotionDecision.create({
        data: {
          ...where,
          sheetId: appliedSheet,
          targetYearId,
          enrolmentId: otherEnrolmentId,
          studentId: otherStudentId,
          proposed: null,
          decision: 'complete',
          reason: 'Leaves after this class',
          decidedBy: f.userId,
          decidedAt: new Date(),
        },
      })
    ).id;
    await db.promotionDecision.updateMany({ where: { ...where, id: appliedRow }, data: { appliedAt: new Date() } });
    await db.promotionSheet.updateMany({
      where: { ...where, id: appliedSheet },
      data: { status: 'applied', appliedBy: f.userId, appliedAt: new Date() },
    });

    leftEnrolmentId = (
      await enrol(db, f.school, { id: f.studentId }, otherSection, {
        startedOn: '2026-04-01',
        status: 'left',
        endedOn: '2026-03-31',
      })
    ).id;
    const second = await createStudent(db, f.school, { admittedOn: '2026-04-01' });
    secondStudentId = second.id;
    secondEnrolmentId = (
      await enrol(db, f.school, second, { id: f.sectionId, classId: f.classId, academicYearId: f.yearId }, { startedOn: '2026-04-01' })
    ).id;
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

  it.each(TABLES)('%s: rows are never deleted or truncated, and school_id never changes', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [f.school.id])).toBe(`${table}_no_delete`);
    expect(await truncateRefused(table)).not.toBeNull();
    expect(
      await refusedBy(`UPDATE ${table} SET school_id = $1 WHERE school_id = $2`, [otherSchoolId, f.school.id]),
    ).toMatch(new RegExp(`^${table}_(school_id_immutable|applied_frozen|sheet_open|status_frozen)$`));
  });

  it('R294: one open sheet per section, into another year; open -> applied only, frozen after', async () => {
    expect(await refusedBy(...sheetRow({ section_id: f.sectionId }))).toBe('promotion_sheets_open_key');
    expect(await refusedBy(...sheetRow({ target_year_id: f.yearId }))).toBe('promotion_sheets_target_year_check');
    // A second section's open sheet beside its applied one is allowed (a late joiner's).
    expect(await refusedBy(...sheetRow())).toBeNull();
    expect(await refusedBy(...sheetRow({ status: 'applied' }))).toBe('promotion_sheets_applied_check');
    expect(await updateSheet(openSheet, `status = 'applied'`)).toBe('promotion_sheets_applied_check');
    expect(await updateSheet(openSheet, `status = 'applied', applied_by = opened_by, applied_at = now()`)).toBeNull();
    expect(await updateSheet(appliedSheet, `status = 'open', applied_by = NULL, applied_at = NULL`)).toMatch(
      /^promotion_sheets_(applied_at_frozen|status_transition)$/,
    );
    expect(await updateSheet(appliedSheet, `applied_at = now() - interval '1 day'`)).toBe('promotion_sheets_applied_at_frozen');
    expect(await updateSheet(openSheet, `section_id = $3`, [otherSectionId])).toBe('promotion_sheets_section_id_immutable');
    expect(await updateSheet(openSheet, `target_year_id = $3`, [f.yearId])).toBe('promotion_sheets_target_year_id_immutable');
  });

  it('R294: a row only on an open sheet, for an enrolment of its section and year', async () => {
    expect(await refusedBy(...decisionRow())).toBe('promotion_decisions_school_id_sheet_id_enrolment_id_key');
    expect(
      await refusedBy(...decisionRow({ enrolment_id: otherEnrolmentId, student_id: otherStudentId })),
    ).toBe('promotion_decisions_enrolment_of_section');
    expect(
      await refusedBy(
        ...decisionRow({ sheet_id: appliedSheet, enrolment_id: otherEnrolmentId, student_id: otherStudentId }),
      ),
    ).toBe('promotion_decisions_sheet_open');
    // The sheet's target year rides on the row (composite foreign key).
    expect(
      await refusedBy(...decisionRow({ enrolment_id: secondEnrolmentId, student_id: secondStudentId, target_year_id: f.yearId })),
    ).toBe('promotion_decisions_sheet_id_fkey');
    expect(await refusedBy(...decisionRow({ enrolment_id: secondEnrolmentId, student_id: secondStudentId }))).toBeNull();
  });

  it('R295, R298: a decision carries its target, and a reason unless it is the proposal', async () => {
    // promote / detain need a class and a section; the others none.
    expect(await updateRow(openRow, `decision = 'promote'`)).toBe('promotion_decisions_target_check');
    expect(await updateRow(openRow, `decision = 'promote', target_class_id = $3`, [targetClassId])).toBe(
      'promotion_decisions_target_check',
    );
    expect(
      await updateRow(openRow, `decision = 'promote', target_class_id = $3, target_section_id = $4`, [targetClassId, targetSectionId]),
    ).toBeNull();
    expect(
      await updateRow(openRow, `decision = 'complete', target_class_id = $3, reason = 'Leaves'`, [targetClassId]),
    ).toBe('promotion_decisions_target_check');
    expect(await updateRow(openRow, `target_section_id = $3`, [targetSectionId])).toBe('promotion_decisions_target_check');
    // Undecided, the row may carry the proposal's target.
    expect(await updateRow(openRow, `target_class_id = $3`, [targetClassId])).toBeNull();
    // A class of another year, or a section of another class, is refused by the composite keys.
    expect(await updateRow(openRow, `target_class_id = $3`, [otherYearClassId])).toBe('promotion_decisions_target_class_id_fkey');
    expect(
      await updateRow(openRow, `target_class_id = $3, target_section_id = $4`, [targetClassId, otherSectionId]),
    ).toBe('promotion_decisions_target_section_id_fkey');
    // R295: a decision other than the proposal, or with no proposal, carries a reason.
    expect(
      await updateRow(openRow, `decision = 'detain', target_class_id = $3, target_section_id = $4`, [targetClassId, targetSectionId]),
    ).toBe('promotion_decisions_reason_check');
    expect(await updateRow(openRow, `decision = 'not_continuing'`)).toBe('promotion_decisions_reason_check');
    expect(await updateRow(openRow, `proposed = NULL, decision = 'complete'`)).toBe('promotion_decisions_reason_check');
    expect(await updateRow(openRow, `decision = 'not_continuing', reason = 'Moving to Lahore'`)).toBeNull();
    expect(await updateRow(openRow, `decision = 'complete', reason = '1234567890123'`)).toBe(
      'promotion_decisions_reason_no_id_check',
    );
    expect(await updateRow(openRow, `decision = 'complete', reason = ' padded '`)).toBe('promotion_decisions_reason_trim_check');
    expect(await updateRow(openRow, `decided_by = $3`, [f.userId])).toBe('promotion_decisions_decided_check');
    // The result read must be the row's own enrolment's.
    expect(await updateRow(openRow, `result_id = $3`, [resultId])).toBeNull();
    expect(await updateRow(openRow, `enrolment_id = $3`, [otherEnrolmentId])).toMatch(
      /^promotion_decisions_(enrolment_id_immutable|result_id_fkey|enrolment_id_fkey)$/,
    );
    expect(await updateRow(openRow, `arrears_flag = true`)).toBe('promotion_decisions_arrears_flag_immutable');
  });

  it('R297: an applied row was decided, opened its enrolment when it moves, and is then frozen but for revised_after_apply', async () => {
    expect(await updateRow(openRow, `applied_at = now()`)).toBe('promotion_decisions_applied_check');
    expect(await updateRow(openRow, `revised_after_apply = true`)).toBe('promotion_decisions_applied_check');
    expect(
      await updateRow(
        openRow,
        `decision = 'promote', target_class_id = $3, target_section_id = $4, applied_at = now()`,
        [targetClassId, targetSectionId],
      ),
    ).toBe('promotion_decisions_applied_check');
    expect(await updateRow(appliedRow, `reason = 'Changed my mind'`)).toBe('promotion_decisions_applied_frozen');
    expect(await updateRow(appliedRow, `applied_at = NULL`)).toBe('promotion_decisions_applied_frozen');
    expect(await updateRow(appliedRow, `revised_after_apply = true`)).toBeNull();
    // Once revised, it stays revised.
    const savepoint = `revised_once_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      await pg.query(`UPDATE promotion_decisions SET revised_after_apply = true WHERE school_id = $1 AND id = $2`, [f.school.id, appliedRow]);
      expect(await updateRow(appliedRow, `revised_after_apply = false`)).toBe('promotion_decisions_applied_frozen');
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  });

  describe('§1.1: results_promotion_revised and results_promotion_returned', () => {
    const revisedOf = async (): Promise<boolean | undefined> => {
      const { rows } = await pg.query<{ revised_after_apply: boolean }>(
        `SELECT revised_after_apply FROM promotion_decisions WHERE school_id = $1 AND id = $2`,
        [f.school.id, openRow],
      );
      return rows[0]?.revised_after_apply;
    };
    /** f's row decided and applied on f's result, its sheet applied. */
    const applyOpenRow = async () => {
      await pg.query(
        `UPDATE promotion_decisions SET decision = 'complete', reason = 'Leaves after this class', decided_by = $3, decided_at = now()
         WHERE school_id = $1 AND id = $2`,
        [f.school.id, openRow, f.userId],
      );
      await pg.query(`UPDATE promotion_decisions SET applied_at = now() WHERE school_id = $1 AND id = $2`, [f.school.id, openRow]);
      await pg.query(
        `UPDATE promotion_sheets SET status = 'applied', applied_by = opened_by, applied_at = now() WHERE school_id = $1 AND id = $2`,
        [f.school.id, openSheet],
      );
    };
    const supersedeResult = () =>
      pg.query(`UPDATE results SET superseded_at = now() WHERE school_id = $1 AND id = $2`, [f.school.id, resultId]);
    /** A correction's replacing row for f's result: the same figures, `revised` as given. */
    const replaceResult = (revised: boolean) =>
      pg.query(
        `INSERT INTO results (school_id, sheet_id, enrolment_id, student_id, academic_year_id, term_id, total_obtained,
           total_max, percent_bp, grade, passed, position, position_of, revised, supersedes_id)
         SELECT school_id, sheet_id, enrolment_id, student_id, academic_year_id, term_id, total_obtained,
           total_max, percent_bp, grade, passed, position, position_of, $3, id
         FROM results WHERE school_id = $1 AND id = $2`,
        [f.school.id, resultId, revised],
      );
    const inSavepoint = async (body: () => Promise<void>) => {
      const savepoint = `revised_${seq++}`;
      await pg.query(`SAVEPOINT ${savepoint}`);
      try {
        await body();
      } finally {
        await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
    };

    it('an open row is never marked: apply re-checks it', () =>
      inSavepoint(async () => {
        await supersedeResult();
        await replaceResult(true);
        expect(await revisedOf()).toBe(false);
      }));

    it('an applied row is not marked when its result is only carried into a new version (revised = false)', () =>
      inSavepoint(async () => {
        await applyOpenRow();
        await supersedeResult();
        expect(await revisedOf()).toBe(false);
        await replaceResult(false);
        expect(await revisedOf()).toBe(false);
      }));

    it('an applied row is marked when the row replacing its result is revised', () =>
      inSavepoint(async () => {
        await applyOpenRow();
        await supersedeResult();
        await replaceResult(true);
        expect(await revisedOf()).toBe(true);
      }));

    it('an applied row is marked when its sheet is returned and its result withdrawn', () =>
      inSavepoint(async () => {
        await applyOpenRow();
        await pg.query(
          `UPDATE result_sheets SET status = 'returned', return_reason = 'Check again' WHERE school_id = $1 AND id = (
             SELECT sheet_id FROM results WHERE school_id = $1 AND id = $2)`,
          [f.school.id, resultId],
        );
        await supersedeResult();
        expect(await revisedOf()).toBe(true);
      }));
  });

  it('§3.2: an enrolment ends once, active -> completed or left', async () => {
    const enrolmentUpdate = (id: bigint, set: string) =>
      refusedBy(`UPDATE enrolments SET ${set} WHERE school_id = $1 AND id = $2`, [f.school.id, id]);
    expect(await enrolmentUpdate(f.enrolmentId, `status = 'completed', ended_on = '2027-03-31'`)).toBeNull();
    expect(await enrolmentUpdate(f.enrolmentId, `status = 'left', ended_on = '2026-09-30'`)).toBeNull();
    expect(await enrolmentUpdate(leftEnrolmentId, `status = 'completed'`)).toBe('enrolments_status_transition');
    expect(await enrolmentUpdate(leftEnrolmentId, `status = 'active', ended_on = NULL`)).toBe('enrolments_status_transition');
  });
});
