// The slice-29 set-up tables in the database (phase-4-academic.md §3.2, R254-R257): no delete, no
// truncate, school_id immutable, frozen columns, the term exclusions and the inside-the-year
// trigger, the live-row uniques and the CHECKs. Each statement is raw SQL inside one transaction
// that is rolled back, behind its own savepoint, so nothing here changes or removes a row even if
// a guard were missing (an exemption in guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createAcademicYear, createClass, createSubject } from '../support/students';

const TABLES = ['academic_terms', 'term_skips', 'result_settings', 'class_subjects'];

describe('slice 29 set-up guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let schoolId: bigint;
  let otherSchoolId: bigint;
  let userId: bigint;
  let yearId: bigint;
  let classId: bigint;
  let otherClassId: bigint;
  let midTerm: bigint;
  let annualTerm: bigint;
  let skip: bigint;
  let endedSkip: bigint;
  let subject: bigint;
  let liveSubject: bigint;
  let archivedSubject: bigint;

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

  /** As money-guards: a TRUNCATE that waits on a busy table proves its guard from the catalogue. */
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

  beforeAll(async () => {
    const school = await createSchool();
    schoolId = school.id;
    otherSchoolId = (await createSchool()).id;
    userId = (await createSchoolUser(db, school, { systemRole: 'principal' })).userId;
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    yearId = year.id;
    await db.$executeRaw`SELECT asms_seed_year_results(${schoolId}::bigint, ${yearId}::bigint)`;
    classId = (await createClass(db, school, year)).id;
    otherClassId = (await createClass(db, school, year)).id;
    if (!(await db.schoolSettings.findFirst({ where: { schoolId } }))) {
      await db.schoolSettings.create({ data: { schoolId } });
    }
    const terms = await db.academicTerm.findMany({ where: { schoolId, academicYearId: yearId }, orderBy: { sortOrder: 'asc' } });
    midTerm = terms[0]!.id;
    annualTerm = terms[1]!.id;
    const skipRow = (extra: object = {}) =>
      db.termSkip.create({
        data: { schoolId, academicYearId: yearId, termId: midTerm, classId, reason: 'Not held', createdBy: userId, ...extra },
      });
    endedSkip = (await skipRow({ endedAt: new Date(), endedBy: userId })).id;
    skip = (await skipRow()).id;
    subject = (await createSubject(db, school)).id;
    const classSubject = (subjectId: bigint, extra: object = {}) =>
      db.classSubject.create({
        data: { schoolId, academicYearId: yearId, classId, subjectId, sortOrder: 1, ...extra },
      });
    liveSubject = (await classSubject(subject)).id;
    archivedSubject = (await classSubject((await createSubject(db, school)).id, { archivedAt: new Date(), archivedBy: userId })).id;
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
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_no_delete`);
    // A referenced table is refused by its foreign keys before the trigger; the trigger itself is
    // checked by the schema guard (EXPECTED_OBJECTS).
    expect(await truncateRefused(table)).not.toBeNull();
    expect(await refusedBy(`UPDATE ${table} SET school_id = $1 WHERE school_id = $2`, [otherSchoolId, schoolId])).toBe(
      `${table}_school_id_immutable`,
    );
  });

  it('academic_terms: no overlap, inside the year (both ways), names unique, at most six, year fixed', async () => {
    const insert = (name: string, from: string, to: string, sortOrder = 3) =>
      refusedBy(
        `INSERT INTO academic_terms (school_id, academic_year_id, name, sort_order, starts_on, ends_on, weight)
         VALUES ($1, $2, $3, $4, $5, $6, 0)`,
        [schoolId, yearId, name, sortOrder, from, to],
      );
    expect(await insert('Extra', '2026-05-01', '2026-05-02')).toBe('academic_terms_no_overlap');
    expect(await insert('Extra', '2026-03-01', '2026-03-02')).toBe('academic_terms_inside_year');
    expect(await refusedBy(`UPDATE academic_terms SET ends_on = '2027-05-01' WHERE school_id = $1 AND id = $2`, [schoolId, midTerm])).toBe(
      'academic_terms_inside_year',
    );
    expect(await refusedBy(`UPDATE academic_years SET ends_on = '2027-02-01' WHERE school_id = $1 AND id = $2`, [schoolId, yearId])).toBe(
      'academic_terms_inside_year',
    );
    expect(await refusedBy(`UPDATE academic_terms SET name = 'ANNUAL' WHERE school_id = $1 AND id = $2`, [schoolId, midTerm])).toBe(
      'academic_terms_name_key',
    );
    expect(await refusedBy(`UPDATE academic_terms SET sort_order = 7 WHERE school_id = $1 AND id = $2`, [schoolId, midTerm])).toBe(
      'academic_terms_sort_order_check',
    );
    expect(await refusedBy(`UPDATE academic_terms SET weight = 101 WHERE school_id = $1 AND id = $2`, [schoolId, midTerm])).toBe(
      'academic_terms_weight_check',
    );
    expect(await refusedBy(`UPDATE academic_terms SET created_by = $3 WHERE school_id = $1 AND id = $2`, [schoolId, midTerm, userId])).toBe(
      'academic_terms_created_by_immutable',
    );
  });

  it('academic_terms: the order is unique per year at commit, so a renumbering may pass through a clash', async () => {
    /** Runs the statements, then checks the deferred exclusion now (as COMMIT would); undone either way. */
    const atCommit = async (statements: [string, unknown[]][]): Promise<string | null> => {
      const savepoint = `renumber_${seq++}`;
      await pg.query(`SAVEPOINT ${savepoint}`);
      try {
        for (const [sql, params] of statements) await pg.query(sql, params);
        await pg.query('SET CONSTRAINTS academic_terms_sort_order_excl IMMEDIATE');
        return null;
      } catch (error) {
        return (error as DatabaseError).constraint ?? (error as Error).message;
      } finally {
        await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await pg.query('SET CONSTRAINTS academic_terms_sort_order_excl DEFERRED');
      }
    };
    const setOrder = (id: bigint, order: number): [string, unknown[]] => [
      'UPDATE academic_terms SET sort_order = $3 WHERE school_id = $1 AND id = $2',
      [schoolId, id, order],
    ];
    // A swap clashes between its two statements; deferred to commit, it passes.
    expect(await atCommit([setOrder(midTerm, 2), setOrder(annualTerm, 1)])).toBeNull();
    expect(await atCommit([setOrder(midTerm, 2)])).toBe('academic_terms_sort_order_excl');
  });

  it('term_skips: one live row per term and class; an ended row is frozen; the facts never change', async () => {
    expect(
      await refusedBy(
        `INSERT INTO term_skips (school_id, academic_year_id, term_id, class_id, reason, created_by) VALUES ($1, $2, $3, $4, 'Again', $5)`,
        [schoolId, yearId, midTerm, classId, userId],
      ),
    ).toBe('term_skips_live_key');
    expect(await refusedBy(`UPDATE term_skips SET ended_at = NULL, ended_by = NULL WHERE school_id = $1 AND id = $2`, [schoolId, endedSkip])).toBe(
      'term_skips_ended_at_frozen',
    );
    expect(await refusedBy(`UPDATE term_skips SET reason = 'Changed' WHERE school_id = $1 AND id = $2`, [schoolId, skip])).toBe(
      'term_skips_reason_immutable',
    );
    expect(await refusedBy(`UPDATE term_skips SET ended_at = now() WHERE school_id = $1 AND id = $2`, [schoolId, skip])).toBe('term_skips_ended_check');
    expect(
      await refusedBy(
        `INSERT INTO term_skips (school_id, academic_year_id, term_id, class_id, reason, created_by) VALUES ($1, $2, $3, $4, '35202-1234567-1', $5)`,
        [schoolId, yearId, annualTerm, classId, userId],
      ),
    ).toBe('term_skips_reason_no_id_check');
  });

  it('result_settings: weights sum to 100, the pass mark is a percent, bands an array of 1-12 with valid grades and minimums, the year fixed', async () => {
    const update = (set: string) => refusedBy(`UPDATE result_settings SET ${set} WHERE school_id = $1 AND academic_year_id = $2`, [schoolId, yearId]);
    expect(await update('test_weight = 30')).toBe('result_settings_weights_check');
    expect(await update('pass_percent = 101')).toBe('result_settings_pass_percent_check');
    expect(await update(`bands = '{"grade": "A"}'`)).toBe('result_settings_bands_check');
    expect(await update(`bands = '[]'`)).toBe('result_settings_bands_check');
    // Security LOW-2: each band's grade is 1-4 of [A-Za-z0-9+-] and its minimum a whole percent.
    for (const bad of [
      '[{"grade": "<b>", "minPercent": 0}]',
      '[{"grade": "ABCDE", "minPercent": 0}]',
      '[{"grade": 5, "minPercent": 0}]',
      '[{"grade": "A", "minPercent": 50.5}]',
      '[{"grade": "A", "minPercent": 101}]',
      '[{"grade": "A", "minPercent": "0"}]',
      '[{"grade": "A"}]',
      '["A"]',
    ]) {
      expect(await update(`bands = '${bad}'`)).toBe('result_settings_band_values_check');
    }
    expect(await update(`bands = '[{"grade": "A+", "minPercent": 90}, {"grade": "B-", "minPercent": 0}]'`)).toBeNull();
    expect(await update('test_weight = 30, exam_weight = 70')).toBeNull();
    expect(
      await refusedBy(
        `INSERT INTO result_settings (school_id, academic_year_id) VALUES ($1, $2)`,
        [schoolId, yearId],
      ),
    ).toBe('result_settings_school_id_academic_year_id_key');
  });

  it('class_subjects: one live row per class and subject; an archived row is frozen; max marks 1-1000', async () => {
    expect(
      await refusedBy(
        `INSERT INTO class_subjects (school_id, academic_year_id, class_id, subject_id, sort_order) VALUES ($1, $2, $3, $4, 2)`,
        [schoolId, yearId, classId, subject],
      ),
    ).toBe('class_subjects_live_key');
    expect(await refusedBy(`UPDATE class_subjects SET exam_max_marks = 1001 WHERE school_id = $1 AND id = $2`, [schoolId, liveSubject])).toBe(
      'class_subjects_exam_max_marks_check',
    );
    expect(await refusedBy(`UPDATE class_subjects SET archived_at = now() WHERE school_id = $1 AND id = $2`, [schoolId, liveSubject])).toBe(
      'class_subjects_archived_check',
    );
    expect(await refusedBy(`UPDATE class_subjects SET archived_at = NULL, archived_by = NULL WHERE school_id = $1 AND id = $2`, [schoolId, archivedSubject])).toBe(
      'class_subjects_archived_at_frozen',
    );
    expect(await refusedBy(`UPDATE class_subjects SET class_id = $3 WHERE school_id = $1 AND id = $2`, [schoolId, liveSubject, otherClassId])).toBe(
      'class_subjects_class_id_immutable',
    );
    expect(await refusedBy(`UPDATE class_subjects SET sort_order = 4, exam_max_marks = 50 WHERE school_id = $1 AND id = $2`, [schoolId, liveSubject])).toBeNull();
  });

  it('classes: a final class has no next class, and no class is its own; the certificate signatory is clean text', async () => {
    expect(await refusedBy(`UPDATE classes SET next_class_id = id WHERE school_id = $1 AND id = $2`, [schoolId, classId])).toBe('classes_next_class_check');
    expect(
      await refusedBy(`UPDATE classes SET next_class_id = $3, is_final = true WHERE school_id = $1 AND id = $2`, [schoolId, classId, otherClassId]),
    ).toBe('classes_next_class_check');
    expect(await refusedBy(`UPDATE classes SET next_class_id = $3 WHERE school_id = $1 AND id = $2`, [schoolId, classId, otherClassId])).toBeNull();
    expect(
      await refusedBy(`UPDATE school_settings SET certificate_signatory_name = '35202-1234567-1' WHERE school_id = $1`, [schoolId]),
    ).toBe('school_settings_certificate_signatory_name_no_id_check');
    expect(
      await refusedBy(`UPDATE school_settings SET certificate_signatory_name = ' Padded ' WHERE school_id = $1`, [schoolId]),
    ).toBe('school_settings_certificate_signatory_name_check');
  });
});
