// The wave I money discipline in the database (phase-3-financial.md rule 0.19, 0.21, §3.1, §3.2,
// §4): keys, CHECKs, transitions, frozen columns, the adjustment credit, the own-child, not-self
// and sole-principal triggers, the exclusion constraints. Each statement is raw SQL inside one
// transaction that is rolled back, behind its own savepoint, so nothing here changes or removes a
// row even if a guard were missing (an exemption in guardrails/no-truncate.spec.ts). Fixtures are
// committed through the guarded client first, in a school of their own.
import { Client, type DatabaseError } from 'pg';
import { createPlatformUser } from '../support/platform';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createClassWithSection, createGuardian, createStudent, enrol, isoDay, linkGuardian } from '../support/students';

type Row = Record<string, unknown>;

describe('wave I money guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let schoolId: bigint;
  let principal: TestSchoolUser;
  let secondPrincipal: TestSchoolUser;
  let office: TestSchoolUser;
  let teacher: TestSchoolUser;
  let year: bigint;
  let enrolment: bigint;
  let student: bigint;
  let otherStudent: bigint;
  let otherEnrolment: bigint;
  const heads: Record<'monthly' | 'once' | 'yearly' | 'fine', bigint> = { monthly: 0n, once: 0n, yearly: 0n, fine: 0n };
  let leaveType: bigint;
  const period = isoDay().slice(0, 7);
  const today = isoDay();

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

  /** Runs statements that stay inside the outer transaction (rolled back at the end). */
  const run = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await pg.query(sql, params)).rows as Row[];

  /** An INSERT ... RETURNING id from column/value pairs. */
  const insert = (table: string, values: Row): [string, unknown[]] => {
    const columns = Object.keys(values);
    return [
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values),
    ];
  };
  const add = async (table: string, values: Row): Promise<bigint> => {
    const [sql, params] = insert(table, values);
    return BigInt((await run(sql, params))[0]?.id as string);
  };
  const tryAdd = (table: string, values: Row) => {
    const [sql, params] = insert(table, values);
    return refusedBy(sql, params);
  };

  const chargeRow = (over: Row = {}): Row => ({
    school_id: schoolId, enrolment_id: enrolment, student_id: student, academic_year_id: year,
    fee_head_id: heads.monthly, head_frequency: 'monthly', kind: 'manual', period, gross_amount: 1000,
    concession_amount: 0, amount: 1000, description: 'Charge', due_on: today, created_by: office.userId,
    ...over,
  });
  const generated = (over: Row = {}) => chargeRow({ kind: 'generated', created_by: null, ...over });

  beforeAll(async () => {
    const school = await createSchool();
    schoolId = school.id;
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    // Not counted until made active inside the transaction (a second principal appears).
    secondPrincipal = await createSchoolUser(db, school, { systemRole: 'principal', userStatus: 'disabled' });
    office = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const { year: y, section } = await createClassWithSection(db, school);
    year = y.id;
    const s = await createStudent(db, school);
    student = s.id;
    enrolment = (await enrol(db, school, s, section)).id;
    const o = await createStudent(db, school);
    otherStudent = o.id;
    otherEnrolment = (await enrol(db, school, o, section)).id;
    // The principal and the office clerk are each a parent of the first student (R232).
    for (const user of [principal, office]) {
      const guardian = await createGuardian(db, school);
      await linkGuardian(db, school, s, guardian, { isPrimaryContact: user === principal });
      await db.user.updateMany({ where: { schoolId, id: user.userId }, data: { guardianId: guardian.id } });
    }
    const head = (name: string, category: 'other' | 'admission' | 'annual' | 'fine', frequency: 'monthly' | 'once' | 'yearly' | 'ad_hoc') =>
      db.feeHead.create({ data: { schoolId, name, category, frequency, concessionEligible: category !== 'fine', refundable: category !== 'admission', createdBy: principal.userId } });
    heads.monthly = (await head('Transport', 'other', 'monthly')).id;
    heads.once = (await head('Admission', 'admission', 'once')).id;
    heads.yearly = (await head('Annual', 'annual', 'yearly')).id;
    heads.fine = (await head('Fine', 'fine', 'ad_hoc')).id;
    leaveType = (await db.leaveType.create({ data: { schoolId, name: 'Casual', code: 'casual', daysPerYear: 10, paid: true, createdBy: principal.userId } })).id;
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

  // ---- charges --------------------------------------------------------------------------------

  it('charges: amounts add up; a generated monthly charge has a period; frozen columns; open means owed', async () => {
    expect(await tryAdd('charges', chargeRow({ gross_amount: 100, concession_amount: 30, amount: 80 }))).toBe('charges_amount_check');
    expect(await tryAdd('charges', generated({ period: null }))).toBe('charges_generated_period_check');
    expect(await tryAdd('charges', generated({ fee_head_id: heads.yearly, head_frequency: 'yearly' }))).toBe('charges_generated_period_check');
    expect(await tryAdd('charges', generated({ head_frequency: 'per_term', period: null }))).toBe('charges_generated_frequency_check');
    expect(await tryAdd('charges', chargeRow({ kind: 'campaign' }))).toBe('charges_campaign_check');
    // R241: an amount of 0 is settled at birth, never open.
    expect(await tryAdd('charges', generated({ gross_amount: 0, amount: 0 }))).toBe('charges_settled_outstanding_check');
    expect(await tryAdd('charges', generated({ gross_amount: 0, amount: 0, status: 'settled', settled_at: new Date() }))).toBeNull();
    expect(await tryAdd('charges', chargeRow({ description: '3520212345671' }))).toBe('charges_description_no_id_check');
    const id = await add('charges', chargeRow());
    for (const [column, value] of [['amount', 5], ['student_id', otherStudent], ['period', '2020-01'], ['due_on', '2020-01-01']] as const) {
      expect(await refusedBy(`UPDATE charges SET ${column} = $2 WHERE id = $1`, [id, value])).toBe(`charges_${column}_immutable`);
    }
  });

  it('charges: the idempotency keys hold among non-voided rows; a voided generated charge frees its key', async () => {
    const first = await add('charges', generated());
    expect(await tryAdd('charges', generated())).toBe('charges_generated_key');
    await run(`UPDATE charges SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Wrong structure' WHERE id = $1`, [first, teacher.userId]);
    expect(await tryAdd('charges', generated())).toBeNull();
    const once = generated({ fee_head_id: heads.once, head_frequency: 'once', period: null });
    await add('charges', once);
    expect(await tryAdd('charges', once)).toBe('charges_once_key');
    expect(await tryAdd('charges', { ...once, enrolment_id: otherEnrolment, student_id: otherStudent })).toBeNull();
    const yearly = generated({ fee_head_id: heads.yearly, head_frequency: 'yearly', period: null });
    await add('charges', yearly);
    expect(await tryAdd('charges', yearly)).toBe('charges_yearly_key');
    const target = await add('charges', chargeRow());
    const late = chargeRow({ kind: 'late_fee', fee_head_id: heads.fine, head_frequency: 'ad_hoc', late_fee_for_charge_id: target, created_by: null });
    await add('charges', late);
    expect(await tryAdd('charges', late)).toBe('charges_late_fee_key');
    expect(await tryAdd('charges', { ...late, period: null })).toBe('charges_late_fee_period_check');
  });

  it('charges: open -> settled | voided | waived; settled -> open only under asms.reversing_payment; only a late fee is waived; no void with allocations', async () => {
    const id = await add('charges', chargeRow());
    expect(await refusedBy(`UPDATE charges SET status = 'waived', waived_at = now(), waived_by = $2, waive_reason = 'Kind' WHERE id = $1`, [id, teacher.userId])).toBe('charges_waived_check');
    await run(`UPDATE charges SET allocated_amount = 400 WHERE id = $1`, [id]);
    expect(await refusedBy(`UPDATE charges SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Wrong' WHERE id = $1`, [id, teacher.userId])).toBe('charges_closed_unallocated_check');
    expect(await refusedBy(`UPDATE charges SET allocated_amount = 1001 WHERE id = $1`, [id])).toBe('charges_allocated_amount_check');
    // Paying the rest settles it in the same statement; leaving it open is refused.
    expect(await refusedBy(`UPDATE charges SET allocated_amount = 1000 WHERE id = $1`, [id])).toBe('charges_settled_outstanding_check');
    await run(`UPDATE charges SET allocated_amount = 1000, status = 'settled', settled_at = now() WHERE id = $1`, [id]);
    const reopen = `UPDATE charges SET allocated_amount = 0, status = 'open', settled_at = NULL WHERE id = $1`;
    expect(await refusedBy(reopen, [id])).toBe('charges_status_transition');
    await run(`SAVEPOINT reversing`);
    await run(`SELECT set_config('asms.reversing_payment', 'on', true)`);
    expect(await refusedBy(reopen, [id])).toBeNull();
    await run(`ROLLBACK TO SAVEPOINT reversing`);
    expect(await refusedBy(`UPDATE charges SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Wrong' WHERE id = $1`, [id, teacher.userId])).toBe('charges_status_transition');
  });

  it('charges: an adjustment raises the original\'s credited_amount and settles it when nothing is owed; never beyond outstanding; only on an open charge', async () => {
    const id = await add('charges', chargeRow());
    const adjustment = (amount: number, target = id) =>
      chargeRow({ kind: 'adjustment', adjusts_charge_id: target, period: null, gross_amount: amount, amount, status: 'settled', settled_at: new Date(), created_by: teacher.userId });
    expect(await tryAdd('charges', { ...adjustment(400), status: 'open', settled_at: null })).toBe('charges_adjustment_row_check');
    await add('charges', adjustment(400));
    expect((await run(`SELECT credited_amount, status FROM charges WHERE id = $1`, [id]))[0]).toEqual({ credited_amount: 400, status: 'open' });
    expect(await tryAdd('charges', adjustment(601))).toBe('charges_allocated_amount_check');
    await add('charges', adjustment(600));
    expect((await run(`SELECT credited_amount, status FROM charges WHERE id = $1`, [id]))[0]).toEqual({ credited_amount: 1000, status: 'settled' });
    expect(await tryAdd('charges', adjustment(1))).toBe('charges_adjustment_target_open');
    expect(await refusedBy(`UPDATE charges SET credited_amount = -1 WHERE id = $1`, [id])).toBe('charges_credited_amount_check');
  });

  it('charges: R232/R253 own child: a parent may not void, waive or adjust their child\'s charge; the sole principal may; a second principal ends the exception', async () => {
    const voidBy = async (actor: bigint) => {
      const id = await add('charges', chargeRow());
      return refusedBy(`UPDATE charges SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Mine' WHERE id = $1`, [id, actor]);
    };
    expect(await voidBy(office.userId)).toBe('charges_own_child');
    expect(await voidBy(teacher.userId)).toBeNull();
    expect(await voidBy(principal.userId)).toBeNull();
    const target = await add('charges', chargeRow());
    const late = await add('charges', chargeRow({ kind: 'late_fee', period: '2020-02', fee_head_id: heads.fine, head_frequency: 'ad_hoc', late_fee_for_charge_id: target, created_by: null }));
    expect(await refusedBy(`UPDATE charges SET status = 'waived', waived_at = now(), waived_by = $2, waive_reason = 'Mine' WHERE id = $1`, [late, office.userId])).toBe('charges_own_child');
    const adjust = (actor: bigint) =>
      tryAdd('charges', chargeRow({ kind: 'adjustment', adjusts_charge_id: target, period: null, gross_amount: 10, amount: 10, status: 'settled', settled_at: new Date(), created_by: actor }));
    expect(await adjust(office.userId)).toBe('charges_own_child');
    expect(await adjust(principal.userId)).toBeNull();
    // Someone else's child is never refused.
    const other = await add('charges', chargeRow({ enrolment_id: otherEnrolment, student_id: otherStudent }));
    expect(await refusedBy(`UPDATE charges SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Wrong' WHERE id = $1`, [other, office.userId])).toBeNull();
    // A second active principal: the sole-principal exception ends.
    await run(`SAVEPOINT two_principals`);
    await run(`UPDATE users SET status = 'active' WHERE school_id = $1 AND id = $2`, [schoolId, secondPrincipal.userId]);
    expect(await voidBy(principal.userId)).toBe('charges_own_child');
    expect(await adjust(principal.userId)).toBe('charges_own_child');
    await run(`ROLLBACK TO SAVEPOINT two_principals`);
  });

  // ---- concessions ----------------------------------------------------------------------------

  const concession = (over: Row = {}): Row => ({
    school_id: schoolId, student_id: student, academic_year_id: year, enrolment_id: enrolment,
    kind: 'percentage', value: 50, effective_from: period, reason: 'Hardship', requested_by: office.userId, ...over,
  });
  const approved = (actor: bigint, over: Row = {}) =>
    concession({ status: 'approved', decided_by: actor, decided_at: new Date(), ...over });

  it('concessions: value by kind; decisions recorded; requested -> approved | rejected, approved -> ended; frozen once decided', async () => {
    expect(await tryAdd('concessions', concession({ value: 101 }))).toBe('concessions_value_check');
    expect(await tryAdd('concessions', concession({ kind: 'fixed', value: 0 }))).toBe('concessions_value_check');
    expect(await tryAdd('concessions', concession({ effective_from: '2026-13' }))).toBe('concessions_effective_from_check');
    expect(await tryAdd('concessions', concession({ status: 'approved' }))).toBe('concessions_decided_check');
    const id = await add('concessions', concession({ enrolment_id: otherEnrolment, student_id: otherStudent }));
    expect(await refusedBy(`UPDATE concessions SET status = 'rejected', decided_at = now(), decided_by = $2 WHERE id = $1`, [id, teacher.userId])).toBe('concessions_decided_check');
    await run(`UPDATE concessions SET status = 'rejected', decided_at = now(), decided_by = $2, decision_reason = 'No' WHERE id = $1`, [id, teacher.userId]);
    expect(await refusedBy(`UPDATE concessions SET status = 'approved' WHERE id = $1`, [id])).toBe('concessions_status_transition');
    expect(await refusedBy(`UPDATE concessions SET decision_reason = 'Changed' WHERE id = $1`, [id])).toBe('concessions_decision_reason_frozen');
    expect(await refusedBy(`UPDATE concessions SET value = 10 WHERE id = $1`, [id])).toBe('concessions_value_immutable');
  });

  it('concessions: R232/R253 own child: refused for a parent; the sole principal only with self_approved; self_approved only for one\'s own child', async () => {
    expect(await tryAdd('concessions', approved(office.userId))).toBe('concessions_own_child');
    expect(await tryAdd('concessions', approved(principal.userId))).toBe('concessions_own_child');
    expect(await tryAdd('concessions', approved(principal.userId, { self_approved: true }))).toBeNull();
    expect(await tryAdd('concessions', approved(principal.userId, { self_approved: true, enrolment_id: otherEnrolment, student_id: otherStudent }))).toBe('concessions_self_approved_unwarranted');
    expect(await tryAdd('concessions', concession({ self_approved: true }))).toBe('concessions_self_approved_check');
    // Approving a pending request is checked too.
    const id = await add('concessions', concession());
    expect(await refusedBy(`UPDATE concessions SET status = 'approved', decided_at = now(), decided_by = $2 WHERE id = $1`, [id, office.userId])).toBe('concessions_own_child');
    await run(`SAVEPOINT two_principals`);
    await run(`UPDATE users SET status = 'active' WHERE school_id = $1 AND id = $2`, [schoolId, secondPrincipal.userId]);
    expect(await tryAdd('concessions', approved(principal.userId, { self_approved: true }))).toBe('concessions_own_child');
    await run(`ROLLBACK TO SAVEPOINT two_principals`);
  });

  it('concession_heads: one row per head; append-only', async () => {
    const id = await add('concessions', concession());
    const head = await add('concession_heads', { school_id: schoolId, concession_id: id, fee_head_id: heads.monthly });
    expect(await tryAdd('concession_heads', { school_id: schoolId, concession_id: id, fee_head_id: heads.monthly })).toBe('concession_heads_school_id_concession_id_fee_head_id_key');
    expect(await refusedBy(`UPDATE concession_heads SET fee_head_id = $2 WHERE id = $1`, [head, heads.yearly])).toBe('concession_heads_fee_head_id_immutable');
  });

  // ---- runs and campaigns ---------------------------------------------------------------------

  it('charge_runs: one queued or running run per year, period and kind; transitions; allowlisted skipped classes', async () => {
    const run1 = await add('charge_runs', { school_id: schoolId, academic_year_id: year, period, kind: 'monthly' });
    expect(await tryAdd('charge_runs', { school_id: schoolId, academic_year_id: year, period, kind: 'monthly' })).toBe('charge_runs_period_key');
    expect(await tryAdd('charge_runs', { school_id: schoolId, academic_year_id: year, period: '2026-1', kind: 'monthly' })).toBe('charge_runs_period_check');
    expect(await tryAdd('charge_runs', { school_id: schoolId, academic_year_id: year, period: '2020-01', kind: 'campaign' })).toBe('charge_runs_campaign_check');
    expect(await refusedBy(`UPDATE charge_runs SET status = 'done', finished_at = now(), started_at = now() WHERE id = $1`, [run1])).toBe('charge_runs_status_transition');
    expect(await refusedBy(`UPDATE charge_runs SET status = 'failed', finished_at = now() WHERE id = $1`, [run1])).toBe('charge_runs_error_code_check');
    expect(await refusedBy(`UPDATE charge_runs SET skipped_classes = '[{"classId":"1","reason":"no_structure","name":"x"}]' WHERE id = $1`, [run1])).toBe('charge_runs_skipped_classes_check');
    expect(await refusedBy(`UPDATE charge_runs SET skipped_classes = '[1]' WHERE id = $1`, [run1])).toBe('charge_runs_skipped_classes_check');
    expect(await refusedBy(`UPDATE charge_runs SET skipped_classes = '[{"classId":"1","reason":"no_structure"}]' WHERE id = $1`, [run1])).toBeNull();
    await run(`UPDATE charge_runs SET status = 'failed', finished_at = now(), error_code = 'stale' WHERE id = $1`, [run1]);
    // A failed run frees the key.
    expect(await tryAdd('charge_runs', { school_id: schoolId, academic_year_id: year, period, kind: 'monthly' })).toBeNull();
    expect(await refusedBy(`UPDATE charge_runs SET period = '2020-01' WHERE id = $1`, [run1])).toBe('charge_runs_period_immutable');
  });

  it('charge_campaigns and their audiences: editable while draft only; the student kinds only', async () => {
    const id = await add('charge_campaigns', { school_id: schoolId, name: 'Exam', academic_year_id: year, fee_head_id: heads.monthly, amount: 500, due_on: today, created_by: office.userId });
    const audience = (over: Row) => tryAdd('charge_campaign_audiences', { school_id: schoolId, campaign_id: id, ...over });
    expect(await audience({ kind: 'staff' })).toBe('charge_campaign_audiences_kind_check');
    expect(await audience({ kind: 'student' })).toBe('charge_campaign_audiences_target_check');
    const row = await add('charge_campaign_audiences', { school_id: schoolId, campaign_id: id, kind: 'student', student_id: student });
    expect(await refusedBy(`UPDATE charge_campaigns SET amount = 600 WHERE id = $1`, [id])).toBeNull();
    await run(`UPDATE charge_campaigns SET status = 'generating' WHERE id = $1`, [id]);
    expect(await refusedBy(`UPDATE charge_campaigns SET amount = 700 WHERE id = $1`, [id])).toBe('charge_campaigns_amount_frozen');
    expect(await audience({ kind: 'everyone' })).toBe('charge_campaign_audiences_draft_only');
    expect(await refusedBy(`DELETE FROM charge_campaign_audiences WHERE id = $1`, [row])).toBe('charge_campaign_audiences_draft_only');
    expect(await refusedBy(`UPDATE charge_campaigns SET status = 'generated' WHERE id = $1`, [id])).toBe('charge_campaigns_generated_check');
    await run(`UPDATE charge_campaigns SET status = 'generated', generated_at = now(), generated_count = 1 WHERE id = $1`, [id]);
    expect(await refusedBy(`UPDATE charge_campaigns SET status = 'draft' WHERE id = $1`, [id])).toBe('charge_campaigns_status_transition');
    // A campaign charge per enrolment, once.
    const campaignCharge = chargeRow({ kind: 'campaign', campaign_id: id, period: null });
    await add('charges', campaignCharge);
    expect(await tryAdd('charges', campaignCharge)).toBe('charges_campaign_key');
  });

  // ---- expenses -------------------------------------------------------------------------------

  let expenseNo = 900_000;
  const expense = (over: Row = {}): Row => ({
    school_id: schoolId, expense_no: expenseNo++, category: 'stationery', amount: 300, spent_on: today,
    description: 'Chalk', method: 'cash', status: 'recorded', recorded_by: office.userId, ...over,
  });

  it('expenses: amounts, methods, receipts and identity numbers; open rows editable, decided rows frozen', async () => {
    expect(await tryAdd('expenses', expense({ amount: 0 }))).toBe('expenses_amount_check');
    expect(await tryAdd('expenses', expense({ method: 'carried_forward' }))).toBe('expenses_method_check');
    expect(await tryAdd('expenses', expense({ payee: '35202-1234567-1' }))).toBe('expenses_payee_no_id_check');
    expect(await tryAdd('expenses', expense({ receipt_object_key: `${schoolId}/x.jpg`, receipt_mime: 'image/jpeg', receipt_size_bytes: 10 }))).toBe('expenses_receipt_check');
    const id = await add('expenses', expense());
    expect(await refusedBy(`UPDATE expenses SET amount = 400 WHERE id = $1`, [id])).toBeNull();
    expect(await refusedBy(`UPDATE expenses SET expense_no = 1 WHERE id = $1`, [id])).toBe('expenses_expense_no_immutable');
    await run(`UPDATE expenses SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [id, principal.userId]);
    expect(await refusedBy(`UPDATE expenses SET amount = 500 WHERE id = $1`, [id])).toBe('expenses_amount_frozen');
    expect(await refusedBy(`UPDATE expenses SET status = 'recorded' WHERE id = $1`, [id])).toBe('expenses_status_transition');
  });

  it('expenses: R244 nobody decides their own; a principal self-approves on record; only a self-approved expense is voided by its recorder after approval', async () => {
    const own = await add('expenses', expense({ status: 'pending_approval' }));
    expect(await refusedBy(`UPDATE expenses SET status = 'approved', decided_by = recorded_by, decided_at = now() WHERE id = $1`, [own])).toBe('expenses_not_self');
    expect(await refusedBy(`UPDATE expenses SET status = 'approved', decided_by = recorded_by, decided_at = now(), self_approved = true WHERE id = $1`, [own])).toBe('expenses_not_self');
    expect(await tryAdd('expenses', expense({ status: 'approved', decided_by: office.userId, decided_at: new Date(), self_approved: true }))).toBe('expenses_not_self');
    const self = await add('expenses', expense({ recorded_by: principal.userId, status: 'approved', decided_by: principal.userId, decided_at: new Date(), self_approved: true }));
    expect(await tryAdd('expenses', expense({ status: 'approved', decided_by: principal.userId, decided_at: new Date(), self_approved: true }))).toBe('expenses_self_approved_check');
    expect(await refusedBy(`UPDATE expenses SET status = 'voided', voided_at = now(), voided_by = recorded_by, void_reason = 'Duplicate' WHERE id = $1`, [self])).toBeNull();
    const approved = await add('expenses', expense({ status: 'approved', decided_by: principal.userId, decided_at: new Date() }));
    expect(await refusedBy(`UPDATE expenses SET status = 'voided', voided_at = now(), voided_by = recorded_by, void_reason = 'Mine' WHERE id = $1`, [approved])).toBe('expenses_not_self');
    expect(await refusedBy(`UPDATE expenses SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = 'Wrong' WHERE id = $1`, [approved, principal.userId])).toBeNull();
    // An open expense is voided by its recorder.
    expect(await refusedBy(`UPDATE expenses SET status = 'voided', voided_at = now(), voided_by = recorded_by, void_reason = 'Typo' WHERE id = $1`, [own])).toBeNull();
  });

  // ---- leave ----------------------------------------------------------------------------------

  const leave = (over: Row = {}): Row => ({
    school_id: schoolId, staff_id: teacher.staffId, leave_type_id: leaveType, starts_on: isoDay(40), ends_on: isoDay(42),
    working_days: 3, reason: 'Family', requested_by: teacher.userId, ...over,
  });

  it('leave_types: unpaid is never paid; frozen; one live name', async () => {
    expect(await tryAdd('leave_types', { school_id: schoolId, name: 'Unpaid', code: 'unpaid', paid: true })).toBe('leave_types_paid_check');
    expect(await tryAdd('leave_types', { school_id: schoolId, name: 'Long', code: 'other', paid: true, days_per_year: 0 })).toBe('leave_types_days_per_year_check');
    expect(await tryAdd('leave_types', { school_id: schoolId, name: 'casual', code: 'other', paid: true })).toBe('leave_types_live_name_key');
    expect(await refusedBy(`UPDATE leave_types SET days_per_year = 20 WHERE id = $1`, [leaveType])).toBe('leave_types_days_per_year_immutable');
  });

  it('leave_requests: dates, overlap, transitions; R210 nobody decides their own; the sole principal approves their own, self_approved', async () => {
    expect(await tryAdd('leave_requests', leave({ ends_on: isoDay(39) }))).toBe('leave_requests_dates_check');
    expect(await tryAdd('leave_requests', leave({ ends_on: isoDay(100) }))).toBe('leave_requests_dates_check');
    const id = await add('leave_requests', leave());
    expect(await tryAdd('leave_requests', leave({ starts_on: isoDay(42), ends_on: isoDay(44) }))).toBe('leave_requests_live_excl');
    expect(await refusedBy(`UPDATE leave_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [id, teacher.userId])).toBe('leave_requests_not_self');
    expect(await refusedBy(`UPDATE leave_requests SET status = 'approved', decided_by = $2, decided_at = now(), self_approved = true WHERE id = $1`, [id, principal.userId])).toBe('leave_requests_self_approved_unwarranted');
    await run(`UPDATE leave_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [id, principal.userId]);
    expect(await refusedBy(`UPDATE leave_requests SET status = 'pending' WHERE id = $1`, [id])).toBe('leave_requests_status_transition');
    // R248: ending early needs the acting user, never the staff member themselves.
    const endEarly = `UPDATE leave_requests SET status = 'ended_early', ended_early_on = starts_on WHERE id = $1`;
    expect(await refusedBy(endEarly, [id])).toBe('leave_requests_actor_required');
    await run(`SAVEPOINT actor`);
    await run(`SELECT set_config('asms.actor_user_id', $1, true)`, [teacher.userId.toString()]);
    expect(await refusedBy(endEarly, [id])).toBe('leave_requests_not_self');
    await run(`SELECT set_config('asms.actor_user_id', $1, true)`, [principal.userId.toString()]);
    expect(await refusedBy(`UPDATE leave_requests SET status = 'ended_early', ended_early_on = ends_on + 1 WHERE id = $1`, [id])).toBe('leave_requests_ended_early_check');
    expect(await refusedBy(endEarly, [id])).toBeNull();
    await run(`ROLLBACK TO SAVEPOINT actor`);
    // A rejected request frees its dates.
    await run(`UPDATE leave_requests SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Plans changed' WHERE id = $1`, [id, teacher.userId]);
    expect(await tryAdd('leave_requests', leave({ starts_on: isoDay(42), ends_on: isoDay(44) }))).toBeNull();
    // The sole principal's own leave.
    const own = await add('leave_requests', leave({ staff_id: principal.staffId, requested_by: principal.userId }));
    expect(await refusedBy(`UPDATE leave_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [own, principal.userId])).toBe('leave_requests_not_self');
    expect(await refusedBy(`UPDATE leave_requests SET status = 'approved', decided_by = $2, decided_at = now(), self_approved = true WHERE id = $1`, [own, principal.userId])).toBeNull();
    await run(`SAVEPOINT two_principals`);
    await run(`UPDATE users SET status = 'active' WHERE school_id = $1 AND id = $2`, [schoolId, secondPrincipal.userId]);
    expect(await refusedBy(`UPDATE leave_requests SET status = 'approved', decided_by = $2, decided_at = now(), self_approved = true WHERE id = $1`, [own, principal.userId])).toBe('leave_requests_not_self');
    await run(`ROLLBACK TO SAVEPOINT two_principals`);
  });

  // ---- platform billing -----------------------------------------------------------------------

  it('platform_plans, subscriptions, invoices and payments: bands never overlap; only the movable columns move', async () => {
    const base = 2_000_000_000;
    const plan = await add('platform_plans', { name: 'Probe A', min_students: base, max_students: base + 10, monthly_price: 1000, sms_allowance: 100 });
    expect(await tryAdd('platform_plans', { name: 'Probe B', min_students: base + 10, max_students: base + 20, monthly_price: 1, sms_allowance: 1 })).toBe('platform_plans_band_excl');
    expect(await tryAdd('platform_plans', { name: 'Probe C', min_students: base + 11, max_students: base + 20, monthly_price: 1, sms_allowance: 1 })).toBeNull();
    expect(await refusedBy(`UPDATE platform_plans SET max_students = $2 WHERE id = $1`, [plan, base + 5])).toBe('platform_plans_max_students_immutable');
    expect(await tryAdd('platform_subscriptions', { school_id: schoolId, plan_id: plan, started_on: today, pinned: true })).toBe('platform_subscriptions_pinned_check');
    const sub = await add('platform_subscriptions', { school_id: schoolId, plan_id: plan, started_on: today });
    expect(await refusedBy(`UPDATE platform_subscriptions SET plan_id = plan_id + 1 WHERE id = $1`, [sub])).toBe('platform_subscriptions_plan_id_immutable');
    await run(`UPDATE platform_subscriptions SET ended_on = started_on WHERE id = $1`, [sub]);
    expect(await refusedBy(`UPDATE platform_subscriptions SET ended_on = NULL WHERE id = $1`, [sub])).toBe('platform_subscriptions_ended_on_frozen');
    const invoice = { school_id: schoolId, invoice_no: 'INV-0000-00001', year_month: '2099-01', plan_id: plan, student_count: 5, amount: 1000, due_on: today };
    expect(await tryAdd('platform_invoices', { ...invoice, invoice_no: 'INV-26-1' })).toBe('platform_invoices_invoice_no_check');
    const inv = await add('platform_invoices', invoice);
    expect(await tryAdd('platform_invoices', { ...invoice, invoice_no: 'INV-0000-00002' })).toBe('platform_invoices_month_key');
    expect(await refusedBy(`UPDATE platform_invoices SET amount = 1 WHERE id = $1`, [inv])).toBe('platform_invoices_amount_immutable');
    await run(`UPDATE platform_invoices SET status = 'paid', paid_at = now() WHERE id = $1`, [inv]);
    expect(await refusedBy(`UPDATE platform_invoices SET status = 'issued' WHERE id = $1`, [inv])).toBe('platform_invoices_status_transition');
    await add('platform_payments', { invoice_id: inv, amount: 1000, received_on: today, reference: 'TRX-1', recorded_by: (await createPlatformUser()).id }); // its own user: a fresh CI database has none
    await add('platform_school_metrics', { school_id: schoolId, day: today, active_students: 3, computed_at: new Date() });
    expect(await refusedBy(`UPDATE platform_payments SET amount = 1 WHERE invoice_id = $1`, [inv])).toBe('platform_payments_amount_immutable');
    expect(await tryAdd('platform_school_metrics', { school_id: schoolId, day: today, active_students: -1, computed_at: new Date() })).toBe('platform_school_metrics_active_students_check');
  });

  const tables = [
    'concessions', 'concession_heads', 'charge_runs', 'charge_campaigns', 'charges', 'expenses',
    'leave_types', 'leave_requests', 'platform_plans', 'platform_subscriptions',
    'platform_school_metrics', 'platform_invoices', 'platform_payments',
  ];
  it.each(tables)('%s: rows are never deleted (last: every table holds a row by now)', async (table) => {
    expect(Number((await run(`SELECT count(*) AS n FROM ${table}`))[0]?.n)).toBeGreaterThan(0);
    expect(await refusedBy(`DELETE FROM ${table} WHERE id = (SELECT max(id) FROM ${table})`)).toBe(`${table}_no_delete`);
    expect(await truncateRefused(table)).not.toBeNull();
  });

});
