// Phase 5 wave U in the database (migration 20261016120000_wave_u_rankings_imports_support;
// phase-5-extended.md §3.2 "Rankings", "Imports", "Support", R333, R339-R343, R349-R352): every
// CHECK, partial unique, trigger and composite foreign key of class_rankings, class_ranking_rows,
// imports, result_sheets.import_id, charges.import_id and platform_support_sessions, written
// directly. Each statement is raw SQL inside one transaction that is rolled back, behind its own
// savepoint, so nothing here changes or removes a row even if a guard were missing (an exemption
// in guardrails/no-truncate.spec.ts). The last block maps a few refusals through the error mapper
// with committed rows of schools of its own.
import { ErrorCode } from '@asms/shared';
import { Client, type DatabaseError } from 'pg';
import { mapDatabaseError } from '../../src/common/errors/prisma-errors';
import { createMarksFixture, type MarksFixture } from '../academics/assessment-fixture';
import { createSheet, moveSheet } from '../results/fixture';
import { createPlatformUser } from '../support/platform';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, enrol } from '../support/students';

const DELETABLE_NEVER = ['class_rankings', 'imports', 'platform_support_sessions'];
const APPEND_ONLY = ['class_ranking_rows'];
const ID = '4210112345671';
const HASH = (n: number) => n.toString(16).padStart(64, '0');

describe('wave U schema: rankings, imports and support sessions (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let f: MarksFixture;
  let schoolId: bigint;
  let office: TestSchoolUser;
  let otherSchoolId: bigint;
  let otherUserId: bigint;
  let platformUserId: bigint;
  /** A second class of the year, with a section. */
  let class2: bigint;
  /** A second section of f's class, with no sheet (imported sheets go here). */
  let sectionB: bigint;
  /** f's published Mid-term and Annual sheets. */
  let midSheet: bigint;
  let annualSheet: bigint;
  /** Students of f's section beside f's own: [studentId, enrolmentId]. */
  let s2: [bigint, bigint];
  let s3: [bigint, bigint];
  let s4: [bigint, bigint];
  let nextYearId: bigint;
  let openingHeadId: bigint;

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

  const one = async (sql: string, params: unknown[] = []): Promise<bigint> => {
    const { rows } = await pg.query<{ id: string }>(sql, params);
    return BigInt(rows[0]!.id);
  };

  // ---- builders, inside the open transaction (kept until the final rollback)

  /** A published result of `enrolment` in `termId` on `sheetId` (percent null = nothing assessed). */
  const result = (
    [studentId, enrolmentId]: [bigint, bigint],
    o: { termId?: bigint; sheetId?: bigint; percentBp?: number | null; published?: boolean } = {},
  ): Promise<bigint> => {
    const assessed = o.percentBp !== null;
    return one(
      `INSERT INTO results (school_id, sheet_id, enrolment_id, student_id, academic_year_id, term_id,
         total_obtained, total_max, percent_bp, grade, passed, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        schoolId, o.sheetId ?? midSheet, enrolmentId, studentId, f.yearId, o.termId ?? f.midTermId,
        assessed ? 60 : 0, assessed ? 100 : 0, assessed ? (o.percentBp ?? 6000) : null,
        assessed ? 'C' : null, assessed ? true : null, o.published === false ? null : new Date(),
      ],
    );
  };

  /** A new live ranking of the class-term: the next version of its chain (stamping the live one). */
  const ranking = async (classId = f.classId, termId = f.midTermId): Promise<bigint> => {
    const tail = await pg.query<{ id: string }>(
      `SELECT r.id FROM class_rankings r
        WHERE r.school_id = $1 AND r.class_id = $2 AND r.term_id = $3
          AND NOT EXISTS (SELECT 1 FROM class_rankings n WHERE n.school_id = r.school_id AND n.supersedes_id = r.id)`,
      [schoolId, classId, termId],
    );
    const previous = tail.rows[0]?.id ?? null;
    if (previous !== null) {
      await pg.query(`UPDATE class_rankings SET superseded_at = now() WHERE id = $1 AND superseded_at IS NULL`, [previous]);
    }
    return one(
      `INSERT INTO class_rankings (school_id, class_id, academic_year_id, term_id, trigger, supersedes_id)
       VALUES ($1, $2, $3, $4, 'publish', $5) RETURNING id`,
      [schoolId, classId, f.yearId, termId, previous],
    );
  };

  const rankRow = (
    rankingId: bigint,
    resultId: bigint,
    [studentId, enrolmentId]: [bigint, bigint],
    position: [number | null, number | null] = [1, 1],
  ): [string, unknown[]] => [
    `INSERT INTO class_ranking_rows (school_id, ranking_id, result_id, student_id, enrolment_id, class_position, position_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [schoolId, rankingId, resultId, studentId, enrolmentId, position[0], position[1]],
  ];

  type ImportCols = Record<string, unknown>;
  const importInsert = (kind: 'past_results' | 'opening_balances', cols: ImportCols = {}): [string, unknown[]] => {
    const row: ImportCols = {
      school_id: schoolId,
      kind,
      file_hash: HASH(++seq),
      file_name: kind === 'past_results' ? 'mid-term.csv' : 'balances.csv',
      row_count: 1,
      rows: JSON.stringify([{ admissionNo: 'A-1' }]),
      academic_year_id: f.yearId,
      created_by: office.userId,
      ...(kind === 'past_results'
        ? { section_id: sectionB, class_id: f.classId, term_id: f.midTermId }
        : { due_on: '2026-10-10' }),
      ...cols,
    };
    const names = Object.keys(row);
    return [
      `INSERT INTO imports (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    ];
  };
  const anImport = (kind: 'past_results' | 'opening_balances', cols: ImportCols = {}) => one(...importInsert(kind, cols));
  const commit = (id: bigint) =>
    pg.query(`UPDATE imports SET status = 'committed', committed_at = now(), committed_by = $2 WHERE id = $1`, [id, office.userId]);

  /** An imported (published, version 1, no submitter) sheet of section B, Mid-term. */
  const importedSheet = (importId: bigint | null, cols: { sectionId?: bigint; termId?: bigint; provenance?: string } = {}): [string, unknown[]] => [
    `INSERT INTO result_sheets (school_id, academic_year_id, term_id, class_id, section_id, created_by, status,
       decided_by, decided_at, published_by, published_at, test_weight, exam_weight, pass_percent, pass_rule, bands,
       provenance, import_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'published', $6, now(), $6, now(), 0, 100, 40, 'all_subjects',
       '[{"grade":"A","minPercent":80}]', $7::sheet_provenance, $8)`,
    [schoolId, f.yearId, cols.termId ?? f.midTermId, f.classId, cols.sectionId ?? sectionB, f.userId, cols.provenance ?? 'imported', importId],
  ];

  /** A manual charge of f's student under the Opening balance head. */
  const charge = (cols: { importId?: bigint | null; dueOn?: string; kind?: string; lateFeeFor?: bigint; yearId?: bigint } = {}): [string, unknown[]] => [
    `INSERT INTO charges (school_id, enrolment_id, student_id, academic_year_id, fee_head_id, head_frequency, kind,
       period, late_fee_for_charge_id, gross_amount, amount, description, due_on, created_by, import_id)
     VALUES ($1, $2, $3, $4, $5, (SELECT frequency FROM fee_heads WHERE id = $5), $6::charge_kind, $7, $8, 1500, 1500,
       'Opening balance', $9, $10, $11)`,
    [
      schoolId, f.enrolmentId, f.studentId, cols.yearId ?? f.yearId, openingHeadId, cols.kind ?? 'manual',
      cols.kind === 'late_fee' ? '2026-10' : null, cols.lateFeeFor ?? null, cols.dueOn ?? '2026-10-10',
      office.userId, cols.importId === undefined ? null : cols.importId,
    ],
  ];

  /** An open support session on the school by `userId` (default a new platform user, so no cap is near). */
  const session = async (o: { userId?: bigint; school?: bigint } = {}): Promise<bigint> =>
    one(
      `INSERT INTO platform_support_sessions (platform_user_id, school_id, reason, ticket_ref, expires_at)
       VALUES ($1, $2, 'Fee report looks wrong', 'TCK-101', now() + interval '4 hours') RETURNING id`,
      [o.userId ?? (await createPlatformUser()).id, o.school ?? schoolId],
    );

  const student = async (sectionId: bigint, classId: bigint): Promise<[bigint, bigint]> => {
    const s = await createStudent(db, f.school, { admittedOn: '2026-04-01' });
    const e = await enrol(db, f.school, s, { id: sectionId, classId, academicYearId: f.yearId }, { startedOn: '2026-04-01' });
    return [s.id, e.id];
  };

  beforeAll(async () => {
    f = await createMarksFixture(await createSchool());
    schoolId = f.school.id;
    office = await createSchoolUser(db, f.school, { systemRole: 'office_staff' });
    const other = await createSchool();
    otherSchoolId = other.id;
    otherUserId = (await createSchoolUser(db, other, { systemRole: 'principal' })).userId;
    platformUserId = (await createPlatformUser()).id;
    const year = { id: f.yearId };
    const k2 = await createClass(db, f.school, year);
    class2 = k2.id;
    await createSection(db, f.school, k2);
    sectionB = (await createSection(db, f.school, { id: f.classId, academicYearId: f.yearId })).id;
    midSheet = (await createSheet(f)).id;
    await moveSheet(f, midSheet, 'published');
    annualSheet = (await createSheet(f, f.annualTermId)).id;
    await moveSheet(f, annualSheet, 'published');
    s2 = await student(f.sectionId, f.classId);
    s3 = await student(f.sectionId, f.classId);
    s4 = await student(f.sectionId, f.classId);
    nextYearId = (await createAcademicYear(db, f.school, { startsOn: '2027-04-01', endsOn: '2028-03-31' })).id;
    await db.$executeRaw`SELECT asms_seed_school_finance(${schoolId}::bigint)`;
    openingHeadId = (await db.feeHead.findFirstOrThrow({ where: { schoolId: f.school.id, name: 'Opening balance' } })).id;
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

  // ---------------------------------------------------------------------------- class_rankings

  describe('class_rankings (R333)', () => {
    it('a version is born live; one live version per class-term; one first version', async () => {
      expect(await refusedBy(
        `INSERT INTO class_rankings (school_id, class_id, academic_year_id, term_id, trigger, superseded_at)
         VALUES ($1, $2, $3, $4, 'publish', now())`,
        [schoolId, f.classId, f.yearId, f.midTermId],
      )).toBe('class_rankings_born_live');
      const first = await ranking();
      const again = `INSERT INTO class_rankings (school_id, class_id, academic_year_id, term_id, trigger)
                     VALUES ($1, $2, $3, $4, 'import')`;
      expect(await refusedBy(again, [schoolId, f.classId, f.yearId, f.midTermId])).toBe('class_rankings_live_key');
      await pg.query(`UPDATE class_rankings SET superseded_at = now() WHERE id = $1`, [first]);
      expect(await refusedBy(again, [schoolId, f.classId, f.yearId, f.midTermId])).toBe('class_rankings_first_key');
      // The other term of the class, and the same term of another class, start their own chains.
      expect(await refusedBy(again, [schoolId, f.classId, f.yearId, f.annualTermId])).toBeNull();
      expect(await refusedBy(again, [schoolId, class2, f.yearId, f.midTermId])).toBeNull();
    });

    it('a version supersedes one already superseded, of its own class and term, at most once', async () => {
      const a = await ranking();
      const supersede = `INSERT INTO class_rankings (school_id, class_id, academic_year_id, term_id, trigger, supersedes_id)
                         VALUES ($1, $2, $3, $4, 'correction', $5)`;
      expect(await refusedBy(supersede, [schoolId, f.classId, f.yearId, f.midTermId, a])).toBe('class_rankings_supersede_order');
      await pg.query(`UPDATE class_rankings SET superseded_at = now() WHERE id = $1`, [a]);
      expect(await refusedBy(supersede, [schoolId, class2, f.yearId, f.midTermId, a])).toBe('class_rankings_supersedes_id_fkey');
      expect(await refusedBy(supersede, [schoolId, f.classId, f.yearId, f.annualTermId, a])).toBe('class_rankings_supersedes_id_fkey');
      const b = await one(`${supersede} RETURNING id`, [schoolId, f.classId, f.yearId, f.midTermId, a]);
      await pg.query(`UPDATE class_rankings SET superseded_at = now() WHERE id = $1`, [b]);
      expect(await refusedBy(supersede, [schoolId, f.classId, f.yearId, f.midTermId, a])).toBe('class_rankings_supersedes_key');
      await one(`${supersede} RETURNING id`, [schoolId, f.classId, f.yearId, f.midTermId, b]);
    });

    it('the class and term are of the version year, in the school', async () => {
      const sql = `INSERT INTO class_rankings (school_id, class_id, academic_year_id, term_id, trigger) VALUES ($1, $2, $3, $4, 'publish')`;
      // Class 2's Annual term has no ranking yet, so only the foreign keys can refuse.
      expect(await refusedBy(sql, [schoolId, class2, nextYearId, f.annualTermId])).toMatch(/^class_rankings_(class|term)_id_fkey$/);
      expect(await refusedBy(sql, [otherSchoolId, class2, f.yearId, f.annualTermId])).toMatch(/^class_rankings_(class|term)_id_fkey$/);
      expect(await refusedBy(sql, [schoolId, class2, f.yearId, f.annualTermId])).toBeNull();
    });

    it('frozen except superseded_at, which is set once', async () => {
      const id = await ranking();
      const cases: [string, string][] = [
        [`trigger = 'import'`, 'class_rankings_trigger_immutable'],
        [`computed_at = now() - interval '1 day'`, 'class_rankings_computed_at_immutable'],
        [`term_id = ${f.annualTermId}`, 'class_rankings_term_id_immutable'],
        [`school_id = ${otherSchoolId}`, 'class_rankings_school_id_immutable'],
      ];
      for (const [set, constraint] of cases) {
        expect(await refusedBy(`UPDATE class_rankings SET ${set} WHERE id = $1`, [id])).toBe(constraint);
      }
      await pg.query(`UPDATE class_rankings SET superseded_at = now() WHERE id = $1`, [id]);
      expect(await refusedBy(`UPDATE class_rankings SET superseded_at = NULL WHERE id = $1`, [id])).toBe('class_rankings_superseded_at_frozen');
    });
  });

  // ---------------------------------------------------------------------------- class_ranking_rows

  describe('class_ranking_rows (R333)', () => {
    let r1: bigint;
    let r2: bigint;
    let r3: bigint;
    let r4: bigint;
    let annual: bigint;

    beforeAll(async () => {
      r1 = await result([f.studentId, f.enrolmentId], { percentBp: 7500 });
      r2 = await result(s2, { percentBp: null });
      r3 = await result(s3, { published: false });
      r4 = await result(s4);
      await pg.query(`UPDATE results SET superseded_at = now() WHERE id = $1`, [r4]);
      annual = await result([f.studentId, f.enrolmentId], { termId: f.annualTermId, sheetId: annualSheet });
    });

    it('positions: both or neither, 1 <= position <= of; a position exactly when the result has a percentage', async () => {
      const rk = await ranking();
      const me: [bigint, bigint] = [f.studentId, f.enrolmentId];
      expect(await refusedBy(...rankRow(rk, r1, me, [0, 2]))).toBe('class_ranking_rows_position_check');
      expect(await refusedBy(...rankRow(rk, r1, me, [3, 2]))).toBe('class_ranking_rows_position_check');
      expect(await refusedBy(...rankRow(rk, r1, me, [1, null]))).toBe('class_ranking_rows_position_check');
      expect(await refusedBy(...rankRow(rk, r1, me, [null, null]))).toBe('class_ranking_rows_unranked');
      expect(await refusedBy(...rankRow(rk, r2, s2, [1, 1]))).toBe('class_ranking_rows_unranked');
      expect(await refusedBy(...rankRow(rk, r1, me, [1, 1]))).toBeNull();
      await pg.query(...rankRow(rk, r1, me, [1, 1]));
      await pg.query(...rankRow(rk, r2, s2, [null, null]));
      expect(await refusedBy(...rankRow(rk, r1, me, [1, 1]))).toBe('class_ranking_rows_ranking_enrolment_key');
    });

    it('a row joins a live version, with a live published result of its term and an enrolment of its class', async () => {
      const me: [bigint, bigint] = [f.studentId, f.enrolmentId];
      const old = await ranking();
      const live = await ranking();
      expect(await refusedBy(...rankRow(old, r1, me))).toBe('class_ranking_rows_ranking_live');
      expect(await refusedBy(...rankRow(live, annual, me))).toBe('class_ranking_rows_result_live');
      expect(await refusedBy(...rankRow(live, r3, s3))).toBe('class_ranking_rows_result_live');
      expect(await refusedBy(...rankRow(live, r4, s4))).toBe('class_ranking_rows_result_live');
      expect(await refusedBy(...rankRow(await ranking(class2), r1, me))).toBe('class_ranking_rows_class');
      expect(await refusedBy(...rankRow(live, r1, me))).toBeNull();
    });

    it('the result, enrolment and student agree (composite FKs)', async () => {
      const live = await ranking();
      expect(await refusedBy(...rankRow(live, r1, [s2[0], s2[1]]))).toBe('class_ranking_rows_result_id_fkey');
      expect(await refusedBy(...rankRow(live, r1, [s2[0], f.enrolmentId]))).toBe('class_ranking_rows_enrolment_id_fkey');
    });

    it('append-only', async () => {
      const live = await ranking();
      await pg.query(...rankRow(live, r1, [f.studentId, f.enrolmentId]));
      expect(await refusedBy(`UPDATE class_ranking_rows SET class_position = 1 WHERE ranking_id = $1`, [live])).toBe('class_ranking_rows_append_only');
    });
  });

  // ---------------------------------------------------------------------------- imports

  describe('imports (R339-R343)', () => {
    it('born previewed; the shape CHECKs', async () => {
      expect(await refusedBy(...importInsert('opening_balances', {
        status: 'committed', committed_at: new Date(), committed_by: office.userId,
      }))).toBe('imports_born_previewed');
      const big = 'x'.repeat(1_048_577);
      const cases: [ImportCols, string][] = [
        [{ file_hash: 'ABC' }, 'imports_file_hash_check'],
        [{ file_hash: HASH(1).toUpperCase().replace(/0/g, 'F') }, 'imports_file_hash_check'],
        [{ file_name: ' balances.csv' }, 'imports_file_name_check'],
        [{ file_name: `${ID}.csv` }, 'imports_file_name_no_id_check'],
        [{ row_count: 5001 }, 'imports_row_count_check'],
        [{ row_count: -1 }, 'imports_row_count_check'],
        [{ rows: '{}' }, 'imports_rows_check'],
        [{ rows: JSON.stringify(Array.from({ length: 5001 }, (_, i) => i)) }, 'imports_rows_check'],
        [{ rows: JSON.stringify([big]) }, 'imports_rows_check'],
        [{ rows: JSON.stringify([{ note: `CNIC ${ID}` }]) }, 'imports_rows_no_id_check'],
        [{ errors: '{}' }, 'imports_errors_check'],
        [{ errors: JSON.stringify([{ row: 2 }]) }, 'imports_errors_check'],
        [{ errors: JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ row: i }))), error_count: 101 }, 'imports_errors_check'],
        [{ errors: JSON.stringify([{ row: 2, field: '35202-1234567-1' }]), error_count: 1 }, 'imports_errors_no_id_check'],
        [{ section_id: sectionB, class_id: f.classId, term_id: f.midTermId }, 'imports_kind_check'],
        [{ due_on: null }, 'imports_kind_check'],
        [{ created_by: otherUserId }, 'imports_created_by_fkey'],
      ];
      for (const [cols, constraint] of cases) expect(await refusedBy(...importInsert('opening_balances', cols))).toBe(constraint);
      expect(await refusedBy(...importInsert('past_results', { due_on: '2026-10-10' }))).toBe('imports_kind_check');
      expect(await refusedBy(...importInsert('past_results', { term_id: null }))).toBe('imports_kind_check');
      expect(await refusedBy(...importInsert('past_results', { class_id: class2 }))).toBe('imports_section_id_fkey');
      expect(await refusedBy(...importInsert('past_results', { academic_year_id: nextYearId }))).toMatch(/^imports_(class|term)_id_fkey$/);
      expect(await refusedBy(...importInsert('past_results'))).toBeNull();
      expect(await refusedBy(...importInsert('opening_balances', { row_count: 0, rows: '[]' }))).toBeNull();
    });

    it('committed once, with no row errors; failed with its error; both final', async () => {
      const withErrors = await anImport('opening_balances', { errors: JSON.stringify([{ row: 2, field: 'amount', code: 'invalid_amount' }]), error_count: 1 });
      expect(await refusedBy(`UPDATE imports SET status = 'committed', committed_at = now(), committed_by = $2 WHERE id = $1`, [withErrors, office.userId])).toBe('imports_committed_check');
      const id = await anImport('opening_balances');
      expect(await refusedBy(`UPDATE imports SET status = 'committed', committed_at = now() WHERE id = $1`, [id])).toBe('imports_committed_check');
      expect(await refusedBy(`UPDATE imports SET status = 'failed', failed_at = now() WHERE id = $1`, [id])).toBe('imports_failed_check');
      expect(await refusedBy(`UPDATE imports SET status = 'failed', failed_at = now(), error = ' expired' WHERE id = $1`, [id])).toBe('imports_error_check');
      expect(await refusedBy(`UPDATE imports SET status = 'failed', failed_at = now(), error = $2 WHERE id = $1`, [id, `row ${ID}`])).toBe('imports_error_no_id_check');
      const cases: [string, string][] = [
        [`rows = '[]'`, 'imports_rows_immutable'],
        [`file_hash = '${HASH(99_999)}'`, 'imports_file_hash_immutable'],
        [`due_on = '2026-11-10'`, 'imports_due_on_immutable'],
        [`error_count = 3`, 'imports_error_count_immutable'],
        [`school_id = ${otherSchoolId}`, 'imports_school_id_immutable'],
      ];
      for (const [set, constraint] of cases) expect(await refusedBy(`UPDATE imports SET ${set} WHERE id = $1`, [id])).toBe(constraint);
      await commit(id);
      expect(await refusedBy(`UPDATE imports SET status = 'failed', failed_at = now(), error = 'expired' WHERE id = $1`, [id])).toBe('imports_status_transition');
      expect(await refusedBy(`UPDATE imports SET status = 'previewed' WHERE id = $1`, [id])).toBe('imports_status_transition');
      expect(await refusedBy(`UPDATE imports SET committed_at = now() + interval '1 minute' WHERE id = $1`, [id])).toBe('imports_committed_at_frozen');
      const failed = await anImport('past_results');
      await pg.query(`UPDATE imports SET status = 'failed', failed_at = now(), error = 'expired' WHERE id = $1`, [failed]);
      expect(await refusedBy(`UPDATE imports SET error = 'other' WHERE id = $1`, [failed])).toBe('imports_error_frozen');
      expect(await refusedBy(`UPDATE imports SET status = 'committed', committed_at = now(), committed_by = $2 WHERE id = $1`, [failed, office.userId])).toBe('imports_status_transition');
    });

    it('R341: a file is committed once per school and kind', async () => {
      const hash = HASH(77_777);
      const a = await anImport('opening_balances', { file_hash: hash });
      const b = await anImport('opening_balances', { file_hash: hash });
      const c = await anImport('past_results', { file_hash: hash });
      await commit(a);
      expect(await refusedBy(`UPDATE imports SET status = 'committed', committed_at = now(), committed_by = $2 WHERE id = $1`, [b, office.userId])).toBe('imports_committed_hash_key');
      expect(await refusedBy(`UPDATE imports SET status = 'committed', committed_at = now(), committed_by = $2 WHERE id = $1`, [c, office.userId])).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------- result_sheets.import_id

  describe('result_sheets.import_id (R340)', () => {
    it('an imported sheet names a previewed past-results import of its section and term; a manual one none', async () => {
      const imp = await anImport('past_results');
      expect(await refusedBy(...importedSheet(null))).toBe('result_sheets_import_id_check');
      expect(await refusedBy(
        `INSERT INTO result_sheets (school_id, academic_year_id, term_id, class_id, section_id, created_by, import_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [schoolId, f.yearId, f.midTermId, f.classId, sectionB, f.userId, imp],
      )).toBe('result_sheets_import_id_check');
      expect(await refusedBy(...importedSheet(await anImport('opening_balances')))).toBe('result_sheets_import_match');
      expect(await refusedBy(...importedSheet(imp, { sectionId: f.sectionId }))).toBe('result_sheets_import_match');
      expect(await refusedBy(...importedSheet(imp, { termId: f.annualTermId }))).toBe('result_sheets_import_match');
      const committed = await anImport('past_results');
      await commit(committed);
      expect(await refusedBy(...importedSheet(committed))).toBe('result_sheets_import_previewed');
      const sheet = await one(`${importedSheet(imp)[0]} RETURNING id`, importedSheet(imp)[1]);
      // One sheet per import (version 1 of the section-term is taken too).
      expect(await refusedBy(...importedSheet(imp))).toMatch(/^result_sheets_(import|version)_key$/);
      expect(await refusedBy(`UPDATE result_sheets SET import_id = $2 WHERE id = $1`, [sheet, await anImport('past_results')])).toBe('result_sheets_import_id_immutable');
      expect(await refusedBy(`UPDATE result_sheets SET import_id = NULL WHERE id = $1`, [sheet])).toBe('result_sheets_import_id_immutable');
    });
  });

  // ---------------------------------------------------------------------------- charges.import_id

  describe('charges.import_id (R342)', () => {
    it('a manual charge of a previewed opening-balances import, due on its date, once per enrolment', async () => {
      const imp = await anImport('opening_balances');
      expect(await refusedBy(...charge({ importId: imp, kind: 'generated' }))).toBe('charges_import_check');
      expect(await refusedBy(...charge({ importId: await anImport('past_results') }))).toBe('charges_import_match');
      expect(await refusedBy(...charge({ importId: imp, dueOn: '2026-10-11' }))).toBe('charges_import_match');
      const nextYear = await anImport('opening_balances', { academic_year_id: nextYearId });
      expect(await refusedBy(...charge({ importId: nextYear }))).toBe('charges_import_id_fkey');
      const committed = await anImport('opening_balances');
      await commit(committed);
      expect(await refusedBy(...charge({ importId: committed }))).toBe('charges_import_previewed');
      const id = await one(`${charge({ importId: imp })[0]} RETURNING id`, charge({ importId: imp })[1]);
      expect(await refusedBy(...charge({ importId: imp }))).toBe('charges_import_enrolment_key');
      expect(await refusedBy(`UPDATE charges SET import_id = NULL WHERE id = $1`, [id])).toBe('charges_import_id_immutable');
      // Committing after the charges is the commit order; the charge still stands.
      await commit(imp);
      expect(await refusedBy(...charge({ importId: null }))).toBeNull();
    });

    it('R342: an opening balance carries no period, so the late-fee sweep never selects it (fix round 20261016130000)', async () => {
      const imp = await anImport('opening_balances');
      // An imported charge with a period is refused: the sweep's candidates all have one.
      const [sql, params] = charge({ importId: imp });
      const withPeriod: unknown[] = [...params];
      withPeriod[6] = '2026-10';
      expect(await refusedBy(sql, withPeriod)).toBe('charges_import_period_check');
      const id = await one(`${sql} RETURNING id`, params);
      expect(await one(`SELECT id FROM charges WHERE id = $1 AND period IS NULL`, [id])).toBe(id);
      // The guard no longer runs on a late fee at all (it fired on every one: the sweep's cost).
      const plain = await one(`${charge()[0]} RETURNING id`, charge()[1]);
      expect(await refusedBy(...charge({ kind: 'late_fee', lateFeeFor: plain }))).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------- platform_support_sessions

  describe('platform_support_sessions (R349, R352)', () => {
    it('born open, time-boxed to 24 hours, with a reason and ticket', async () => {
      const insert = (cols: string, values: string, params: unknown[] = []) =>
        refusedBy(
          `INSERT INTO platform_support_sessions (platform_user_id, school_id, reason, ticket_ref, expires_at${cols})
           VALUES ($1, $2, $3, $4, now() + interval '4 hours'${values})`,
          [platformUserId, otherSchoolId, 'Fee report looks wrong', 'TCK-1', ...params],
        );
      expect(await insert(', closed_at, end_kind', `, now(), 'closed'`)).toBe('platform_support_sessions_born_open');
      const raw = (reason: string, ticket: string, expires: string) =>
        refusedBy(
          `INSERT INTO platform_support_sessions (platform_user_id, school_id, reason, ticket_ref, expires_at)
           VALUES ($1, $2, $3, $4, now() + $5::interval)`,
          [platformUserId, otherSchoolId, reason, ticket, expires],
        );
      expect(await raw(' Fee report', 'TCK-1', '4 hours')).toBe('platform_support_sessions_reason_check');
      expect(await raw(`Parent ${ID}`, 'TCK-1', '4 hours')).toBe('platform_support_sessions_reason_no_id_check');
      expect(await raw('Fee report', '', '4 hours')).toBe('platform_support_sessions_ticket_ref_check');
      expect(await raw('Fee report', ID, '4 hours')).toBe('platform_support_sessions_ticket_ref_no_id_check');
      expect(await raw('Fee report', 'TCK-1', '0 hours')).toBe('platform_support_sessions_expires_check');
      expect(await raw('Fee report', 'TCK-1', '24 hours 1 second')).toBe('platform_support_sessions_expires_check');
      expect(await raw('Fee report', 'TCK-1', '24 hours')).toBeNull();
    });

    it('one open session per school; at most three open per platform user', async () => {
      const user = (await createPlatformUser()).id;
      const schools = [await createSchool(), await createSchool(), await createSchool(), await createSchool()];
      await session({ userId: user, school: schools[0]!.id });
      expect(await refusedBy(
        `INSERT INTO platform_support_sessions (platform_user_id, school_id, reason, ticket_ref, expires_at)
         VALUES ($1, $2, 'Second look', 'TCK-2', now() + interval '1 hour')`,
        [platformUserId, schools[0]!.id],
      )).toBe('platform_support_sessions_open_key');
      await session({ userId: user, school: schools[1]!.id });
      const third = await session({ userId: user, school: schools[2]!.id });
      expect(await refusedBy(
        `INSERT INTO platform_support_sessions (platform_user_id, school_id, reason, ticket_ref, expires_at)
         VALUES ($1, $2, 'Fourth', 'TCK-4', now() + interval '1 hour')`,
        [user, schools[3]!.id],
      )).toBe('platform_support_sessions_user_limit');
      await pg.query(`UPDATE platform_support_sessions SET closed_at = now(), end_kind = 'closed' WHERE id = $1`, [third]);
      expect(await session({ userId: user, school: schools[3]!.id })).toBeGreaterThan(0n);
    });

    it('close, revoke and expiry each set closed_at with how it ended; the groups are set once', async () => {
      /** A session on a new school; tries `set` ($2 = `extra`, by default a user of that school). */
      const close = async (set: string, extra?: unknown) => {
        const school = await createSchool();
        const userId = (await createSchoolUser(db, school, { systemRole: 'principal' })).userId;
        const id = await session({ school: school.id });
        const params = set.includes('$2') ? [id, extra ?? userId] : [id];
        return { id, refusal: await refusedBy(`UPDATE platform_support_sessions SET ${set} WHERE id = $1`, params) };
      };
      expect((await close(`closed_at = now()`)).refusal).toBe('platform_support_sessions_closed_check');
      expect((await close(`end_kind = 'closed'`)).refusal).toBe('platform_support_sessions_closed_check');
      expect((await close(`closed_at = now(), end_kind = 'expired'`)).refusal).toBe('platform_support_sessions_closed_check');
      expect((await close(`closed_at = now(), end_kind = 'revoked', close_reason = 'Done'`)).refusal).toBe('platform_support_sessions_closed_check');
      expect((await close(`closed_at = now(), end_kind = 'revoked'`)).refusal).toBe('platform_support_sessions_revoked_check');
      expect((await close(`closed_at = now(), end_kind = 'closed', revoked_at = now(), revoked_by = $2, revoke_reason = 'No'`)).refusal).toBe('platform_support_sessions_revoked_check');
      expect((await close(`closed_at = now(), end_kind = 'revoked', revoked_at = now() - interval '1 second', revoked_by = $2, revoke_reason = 'No'`)).refusal).toBe('platform_support_sessions_revoked_check');
      expect((await close(`closed_at = now(), end_kind = 'closed', close_reason = $2`, `Ticket ${ID}`)).refusal).toBe('platform_support_sessions_close_reason_no_id_check');
      expect((await close(`closed_at = now(), end_kind = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = ' '`)).refusal).toBe('platform_support_sessions_revoke_reason_check');
      expect((await close(`reason = 'Changed'`)).refusal).toBe('platform_support_sessions_reason_immutable');
      expect((await close(`expires_at = now() + interval '8 hours'`)).refusal).toBe('platform_support_sessions_expires_at_immutable');
      expect((await close(`school_id = $2`, otherSchoolId)).refusal).toBe('platform_support_sessions_school_id_immutable');

      // The revoker is a user of the session's school.
      const revoke = `UPDATE platform_support_sessions SET closed_at = now(), end_kind = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = 'Not agreed' WHERE id = $1`;
      const revoked = await session({ school: schoolId });
      expect(await refusedBy(revoke, [revoked, otherUserId])).toBe('platform_support_sessions_revoked_by_school_user');
      await pg.query(revoke, [revoked, f.userId]);
      expect(await refusedBy(`UPDATE platform_support_sessions SET end_kind = 'closed', revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE id = $1`, [revoked])).toBe('platform_support_sessions_end_kind_frozen');
      expect(await refusedBy(`UPDATE platform_support_sessions SET revoke_reason = 'Other' WHERE id = $1`, [revoked])).toBe('platform_support_sessions_revoke_reason_frozen');

      // A closed session is not revoked afterwards; an expiry is at or after expires_at.
      const closed = (await close(`closed_at = now(), end_kind = 'closed', close_reason = 'Answered'`)).id;
      await pg.query(`UPDATE platform_support_sessions SET closed_at = now(), end_kind = 'closed', close_reason = 'Answered' WHERE id = $1`, [closed]);
      expect(await refusedBy(revoke, [closed, f.userId])).toBe('platform_support_sessions_end_kind_frozen');
      const expiring = await one(
        `INSERT INTO platform_support_sessions (platform_user_id, school_id, reason, ticket_ref, opened_at, expires_at)
         VALUES ($1, $2, 'Overnight check', 'TCK-9', now() - interval '5 hours', now() - interval '1 hour') RETURNING id`,
        [(await createPlatformUser()).id, (await createSchool()).id],
      );
      expect(await refusedBy(`UPDATE platform_support_sessions SET closed_at = now(), end_kind = 'expired' WHERE id = $1`, [expiring])).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------- rule 4

  it.each(DELETABLE_NEVER)('rule 4: %s rows are never deleted', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_no_delete`);
  });

  it.each(APPEND_ONLY)('rule 4: %s is append-only', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_append_only`);
  });

  it.each([...DELETABLE_NEVER, ...APPEND_ONLY])('rule 4: %s is never truncated', async (table) => {
    expect(await truncateRefused(table)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------- the error mapper

describe('wave U schema: refusals reach the error mapper', () => {
  let db: ReturnType<typeof testDb>;
  beforeAll(() => {
    db = testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const mapped = async (write: Promise<unknown>) => {
    try {
      await write;
      return 'accepted';
    } catch (error) {
      const api = mapDatabaseError(error);
      return api ? { status: api.status, code: api.code } : String(error);
    }
  };

  it('a second commit of a file is IMPORT_DUPLICATE_FILE; committing twice is IMPORT_NOT_PREVIEWED', async () => {
    const school = await createSchool();
    const office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const row = {
      schoolId: school.id, kind: 'opening_balances' as const, fileHash: HASH(4242), fileName: 'balances.csv',
      rowCount: 0, rows: [], academicYearId: year.id, dueOn: new Date('2026-10-10T00:00:00Z'), createdBy: office.userId,
    };
    const a = await db.import.create({ data: row });
    const b = await db.import.create({ data: row });
    const committed = { status: 'committed' as const, committedAt: new Date(), committedBy: office.userId };
    await db.import.updateMany({ where: { schoolId: school.id, id: a.id }, data: committed });
    expect(await mapped(db.import.updateMany({ where: { schoolId: school.id, id: b.id }, data: committed }))).toEqual({
      status: 409,
      code: ErrorCode.IMPORT_DUPLICATE_FILE,
    });
    expect(await mapped(db.import.updateMany({
      where: { schoolId: school.id, id: a.id },
      data: { status: 'failed', failedAt: new Date(), error: 'expired' },
    }))).toEqual({ status: 409, code: ErrorCode.IMPORT_NOT_PREVIEWED });
  });

  it('a second open session on a school is SUPPORT_SESSION_OPEN; a fourth for one user is SUPPORT_SESSION_LIMIT', async () => {
    const user = (await createPlatformUser()).id;
    const open = (schoolId: bigint, platformUserId = user) =>
      db.platformSupportSession.create({
        data: { platformUserId, schoolId, reason: 'Fee report', ticketRef: 'TCK-5', expiresAt: new Date(Date.now() + 3_600_000) },
      });
    const first = await createSchool();
    await open(first.id);
    expect(await mapped(open(first.id, (await createPlatformUser()).id))).toEqual({ status: 409, code: ErrorCode.SUPPORT_SESSION_OPEN });
    await open((await createSchool()).id);
    await open((await createSchool()).id);
    expect(await mapped(open((await createSchool()).id))).toEqual({ status: 409, code: ErrorCode.SUPPORT_SESSION_LIMIT });
  });
});
