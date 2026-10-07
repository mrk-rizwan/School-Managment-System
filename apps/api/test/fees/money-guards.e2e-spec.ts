// The slice-18 money discipline in the database (phase-3-financial.md rule 0.19, §3.2): no delete,
// no truncate, frozen columns, final archive and disable, the fine and admission CHECKs. Each
// statement is raw SQL inside one transaction that is rolled back, behind its own savepoint, so
// nothing here changes or removes a row even if a guard were missing (an exemption in
// guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createAcademicYear, createClass } from '../support/students';

describe('slice 18 money guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let head: bigint;
  let archivedHead: bigint;
  let structure: bigint;
  let superseded: bigint;
  let account: bigint;
  let disabled: bigint;

  /** The constraint a statement is refused by (null when it succeeds), then undone either way. */
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

  /**
   * TRUNCATE takes an exclusive lock on the whole table, so on CI it can wait behind another suite
   * using the same table; under the suite's lock_timeout that wait fails fast. A busy table then
   * proves the refusal from the catalogue instead: a TRUNCATE trigger, or another table's foreign
   * key, which Postgres refuses a plain TRUNCATE for.
   */
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
    const user = await createSchoolUser(db, school, { systemRole: 'principal' });
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const cls = await createClass(db, school, year);
    const make = (name: string, archived: boolean) =>
      db.feeHead.create({
        data: {
          schoolId: school.id,
          name,
          category: 'other',
          frequency: 'monthly',
          concessionEligible: true,
          refundable: true,
          createdBy: user.userId,
          ...(archived ? { status: 'archived', archivedAt: new Date(), archivedBy: user.userId, archiveReason: 'Old' } : {}),
        },
      });
    head = (await make('Transport', false)).id;
    archivedHead = (await make('Library', true)).id;
    const row = (month: string, extra: object = {}) =>
      db.feeStructure.create({
        data: { schoolId: school.id, academicYearId: year.id, classId: cls.id, feeHeadId: head, amount: 1000, effectiveFrom: month, createdBy: user.userId, ...extra },
      });
    superseded = (await row('2026-04', { status: 'superseded', supersededAt: new Date() })).id;
    structure = (await row('2026-05')).id;
    const acct = (extra: object = {}) =>
      db.schoolPaymentAccount.create({
        data: { schoolId: school.id, kind: 'bank', title: 'School', accountNo: 'PK36SCBL0000001123456702', bankName: 'Bank', createdBy: user.userId, ...extra },
      });
    account = (await acct()).id;
    disabled = (await acct({ status: 'disabled', disabledAt: new Date(), disabledBy: user.userId, disableReason: 'Closed' })).id;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
    // A guard that waits on a lock would hang the suite; fail fast instead (see truncateRefused).
    await pg.query(`SET LOCAL lock_timeout = '5s'`);
  });

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  it.each(['fee_heads', 'fee_structures', 'school_payment_accounts'])('%s: rows are never deleted or truncated', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE id = (SELECT max(id) FROM ${table})`)).toBe(`${table}_no_delete`);
    // A referenced table is refused by its foreign keys before the trigger; the trigger itself is
    // checked by the schema guard (EXPECTED_OBJECTS).
    expect(await truncateRefused(table)).not.toBeNull();
  });

  it('fee_heads: category and frequency are frozen; archive is final; a fine is never concession-eligible; an admission fee never refundable', async () => {
    expect(await refusedBy(`UPDATE fee_heads SET category = 'exam' WHERE id = $1`, [head])).toBe('fee_heads_category_immutable');
    expect(await refusedBy(`UPDATE fee_heads SET frequency = 'yearly' WHERE id = $1`, [head])).toBe('fee_heads_frequency_immutable');
    expect(await refusedBy(`UPDATE fee_heads SET name = 'Bus' WHERE id = $1`, [head])).toBeNull();
    expect(
      await refusedBy(`UPDATE fee_heads SET status = 'active', archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = $1`, [archivedHead]),
    ).toBe('fee_heads_archived_at_frozen');
    expect(await refusedBy(`UPDATE fee_heads SET name = 'Books' WHERE id = $1`, [archivedHead])).toBe('fee_heads_name_frozen');
    expect(await refusedBy(`UPDATE fee_heads SET status = 'archived' WHERE id = $1`, [head])).toBe('fee_heads_archived_check');
    const insert = (category: string, eligible: boolean, refundable: boolean) =>
      refusedBy(
        `INSERT INTO fee_heads (school_id, name, category, frequency, concession_eligible, refundable)
         SELECT school_id, 'Probe ' || $1, $1::fee_head_category, 'ad_hoc', $2, $3 FROM fee_heads WHERE id = $4`,
        [category, eligible, refundable, head],
      );
    expect(await insert('fine', true, true)).toBe('fee_heads_fine_concession_check');
    expect(await insert('admission', true, true)).toBe('fee_heads_admission_refundable_check');
    expect(await refusedBy(`UPDATE fee_heads SET name = '3520212345671' WHERE id = $1`, [head])).toBe('fee_heads_name_no_id_check');
  });

  it('fee_structures: amount, class, head and month are frozen; superseding is final; one active row per class, head and month', async () => {
    for (const [column, value] of [
      ['amount', '2000'],
      ['effective_from', "'2026-06'"],
      ['fee_head_id', String(archivedHead)],
    ] as const) {
      expect(await refusedBy(`UPDATE fee_structures SET ${column} = ${value} WHERE id = $1`, [structure])).toBe(`fee_structures_${column}_immutable`);
    }
    expect(await refusedBy(`UPDATE fee_structures SET status = 'active', superseded_at = NULL WHERE id = $1`, [superseded])).toBe('fee_structures_superseded_at_frozen');
    expect(await refusedBy(`UPDATE fee_structures SET status = 'superseded' WHERE id = $1`, [structure])).toBe('fee_structures_superseded_check');
    expect(await refusedBy(`UPDATE fee_structures SET superseded_by = id WHERE id = $1`, [superseded])).toBe('fee_structures_superseded_check');
    expect(
      await refusedBy(
        `INSERT INTO fee_structures (school_id, academic_year_id, class_id, fee_head_id, amount, effective_from, created_by)
         SELECT school_id, academic_year_id, class_id, fee_head_id, 5, effective_from, created_by FROM fee_structures WHERE id = $1`,
        [structure],
      ),
    ).toBe('fee_structures_active_key');
    expect(await refusedBy(`UPDATE fee_structures SET amount = -1 WHERE id = $1`, [structure])).toBe('fee_structures_amount_immutable');
  });

  it('school_payment_accounts: the payee is frozen; disabling is final; no identity-shaped account number', async () => {
    expect(await refusedBy(`UPDATE school_payment_accounts SET account_no = 'PK00X' WHERE id = $1`, [account])).toBe('school_payment_accounts_account_no_immutable');
    expect(await refusedBy(`UPDATE school_payment_accounts SET title = 'Someone else' WHERE id = $1`, [account])).toBe('school_payment_accounts_title_immutable');
    expect(
      await refusedBy(`UPDATE school_payment_accounts SET status = 'active', disabled_at = NULL, disabled_by = NULL, disable_reason = NULL WHERE id = $1`, [disabled]),
    ).toBe('school_payment_accounts_disabled_at_frozen');
    const insert = (accountNo: string, kind = 'bank', bank: string | null = null) =>
      refusedBy(
        `INSERT INTO school_payment_accounts (school_id, kind, title, account_no, bank_name, created_by)
         SELECT school_id, $2::payment_account_kind, 'Probe', $1, $3, created_by FROM school_payment_accounts WHERE id = $4`,
        [accountNo, kind, bank, account],
      );
    expect(await insert('3520212345671')).toBe('school_payment_accounts_account_no_check');
    expect(await insert('35202-1234567-1')).toBe('school_payment_accounts_account_no_check');
    expect(await insert('03001234567', 'jazzcash', 'A bank')).toBe('school_payment_accounts_bank_name_check');
    expect(await insert('03001234567', 'jazzcash')).toBeNull();
  });
});
