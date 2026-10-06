// The wave J money discipline in the database (phase-3-financial.md rule 0.19-0.22, §3.2, §3.4,
// §4 "Payments" and "Payroll"): the increment triggers and their CHECKs, the reversal trigger
// under asms.reversing_payment, the deferred constraint triggers, custody and handovers, the
// not-self and own-child triggers with the sole-principal exception, the exclusion constraint and
// the payroll freeze. Each statement is raw SQL inside one transaction that is rolled back, behind
// its own savepoint, so nothing here changes or removes a row even if a guard were missing (an
// exemption in guardrails/no-truncate.spec.ts). The commit-time checks run in transactions of
// their own that are refused at COMMIT, so they leave nothing behind either. Fixtures are
// committed through the guarded client first, in a school of their own.
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createClassWithSection, createGuardian, createStudent, enrol, isoDay, linkGuardian } from '../support/students';

type Row = Record<string, unknown>;

/** The constraint name a pg error names: the field, or the DETAIL every trigger function writes. */
const constraintOf = (error: unknown): string => {
  const e = error as DatabaseError;
  return e.constraint ?? e.detail?.replace(/^constraint: /, '') ?? e.message;
};

/** An INSERT ... RETURNING id from column/value pairs. */
const insertSql = (table: string, values: Row): [string, unknown[]] => {
  const columns = Object.keys(values);
  return [
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(values),
  ];
};

describe('wave J money guards (raw SQL)', () => {
  const db = testDb();
  let schoolId: bigint;
  let principal: TestSchoolUser;
  let secondPrincipal: TestSchoolUser;
  let clerk: TestSchoolUser;
  /** The other clerk is a parent of `student` (R232). */
  let parentClerk: TestSchoolUser;
  let teacher: TestSchoolUser;
  let year: bigint;
  let nextYear: bigint;
  let student: bigint;
  let enrolment: bigint;
  let otherStudent: bigint;
  let monthlyHead: bigint;
  let admissionHead: bigint;
  let parentGuardian: bigint;
  const today = isoDay();
  const period = today.slice(0, 7);

  beforeAll(async () => {
    const school = await createSchool();
    schoolId = school.id;
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    // Not counted until made active inside the transaction (a second principal appears).
    secondPrincipal = await createSchoolUser(db, school, { systemRole: 'principal', userStatus: 'disabled' });
    clerk = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    parentClerk = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const first = await createClassWithSection(db, school);
    const second = await createClassWithSection(db, school);
    year = first.year.id;
    nextYear = second.year.id;
    const s = await createStudent(db, school);
    student = s.id;
    enrolment = (await enrol(db, school, s, first.section, { status: 'completed' })).id;
    await enrol(db, school, s, second.section);
    const o = await createStudent(db, school);
    otherStudent = o.id;
    await enrol(db, school, o, first.section);
    const guardian = await createGuardian(db, school);
    parentGuardian = guardian.id;
    await linkGuardian(db, school, s, guardian);
    await db.user.updateMany({ where: { schoolId, id: parentClerk.userId }, data: { guardianId: guardian.id } });
    monthlyHead = (await db.feeHead.create({ data: { schoolId, name: 'Transport', category: 'other', frequency: 'monthly', concessionEligible: true, refundable: true, createdBy: principal.userId } })).id;
    admissionHead = (await db.feeHead.create({ data: { schoolId, name: 'Admission', category: 'admission', frequency: 'once', concessionEligible: true, refundable: false, createdBy: principal.userId } })).id;
  });

  afterAll(() => closeTestDb());

  const paymentRow = (over: Row = {}): Row => ({
    school_id: schoolId, academic_year_id: year, payer_name: 'Walk-in parent', method: 'cash', amount: 1000,
    received_on: today, recorded_by: clerk.userId, verified_by: clerk.userId, advance_for_student_id: student, ...over,
  });

  describe('in one rolled-back transaction', () => {
    let pg: Client;
    let seq = 0;

    /** The constraint a statement is refused by (null when it succeeds), then undone either way. */
    const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> => {
      const savepoint = `guard_${seq++}`;
      await pg.query(`SAVEPOINT ${savepoint}`);
      try {
        await pg.query(sql, params);
        return null;
      } catch (error) {
        return constraintOf(error);
      } finally {
        await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
    };
    /** Runs statements that stay inside the outer transaction (rolled back at the end). */
    const run = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await pg.query(sql, params)).rows as Row[];
    const add = async (table: string, values: Row): Promise<bigint> => {
      const [sql, params] = insertSql(table, values);
      return BigInt((await run(sql, params))[0]?.id as string);
    };
    const tryAdd = (table: string, values: Row) => refusedBy(...insertSql(table, values));
    const one = async (sql: string, params: unknown[] = []) => (await run(sql, params))[0];
    /** Checks a deferred constraint now, inside a savepoint, and puts it back to deferred. */
    const checkNow = async (constraint: string) => {
      const result = await refusedBy(`SET CONSTRAINTS ${constraint} IMMEDIATE`);
      await run(`SET CONSTRAINTS ${constraint} DEFERRED`);
      return result;
    };
    const reversing = async () => (await one(`SELECT coalesce(current_setting('asms.reversing_payment', true), '') AS v`))?.v;

    const charge = (over: Row = {}) =>
      add('charges', {
        school_id: schoolId, enrolment_id: enrolment, student_id: student, academic_year_id: year,
        fee_head_id: monthlyHead, head_frequency: 'monthly', kind: 'manual', period, gross_amount: 1000,
        concession_amount: 0, amount: 1000, description: 'Charge', due_on: today, created_by: principal.userId, ...over,
      });
    const allocation = (paymentId: bigint, chargeId: bigint, amount: number, over: Row = {}): Row => ({
      school_id: schoolId, payment_id: paymentId, charge_id: chargeId, student_id: student, academic_year_id: year, amount, ...over,
    });
    const reversal = (paymentId: bigint, kind: string, amount: number, over: Row = {}): Row => ({
      school_id: schoolId, payment_id: paymentId, academic_year_id: year, kind, amount, reason: 'Correction',
      requested_by: principal.userId,
      ...(kind === 'refund' || kind === 'refund_reversal' ? { approved_by: principal.userId } : {}),
      ...(kind === 'refund' ? { refund_method: 'cash' } : {}),
      ...over,
    });
    const chargeState = (id: bigint) => one(`SELECT allocated_amount, status, settled_at IS NOT NULL AS settled FROM charges WHERE id = $1`, [id]);
    const unallocated = async (id: bigint) => (await one(`SELECT unallocated_amount FROM payments WHERE id = $1`, [id]))?.unallocated_amount;

    beforeAll(async () => {
      pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      await pg.query('BEGIN');
    });

    afterAll(async () => {
      await pg.query('ROLLBACK');
      await pg.end();
    });

    // ---- payments -------------------------------------------------------------------------------

    it('payments: amounts, payer, reference and method CHECKs; born verified with everything unallocated; frozen columns', async () => {
      expect(await tryAdd('payments', paymentRow({ amount: 0 }))).toBe('payments_amount_check');
      expect(await tryAdd('payments', paymentRow({ payer_guardian_id: parentGuardian }))).toBe('payments_payer_check');
      expect(await tryAdd('payments', paymentRow({ payer_name: null }))).toBe('payments_payer_check');
      expect(await tryAdd('payments', paymentRow({ payer_name: '3520212345671' }))).toBe('payments_payer_name_no_id_check');
      expect(await tryAdd('payments', paymentRow({ method: 'bank_transfer' }))).toBe('payments_reference_required_check');
      expect(await tryAdd('payments', paymentRow({ method: 'carried_forward' }))).toBe('payments_carried_forward_check');
      expect(await tryAdd('payments', paymentRow({ status: 'voided', voided_at: new Date() }))).toBe('payments_born_verified');
      const id = await add('payments', paymentRow({ unallocated_amount: 5 }));
      expect(await unallocated(id)).toBe(1000);
      for (const [column, value] of [['amount', 5], ['method', 'jazzcash'], ['received_on', '2020-01-01'], ['recorded_by', teacher.userId]] as const) {
        expect(await refusedBy(`UPDATE payments SET ${column} = $2 WHERE id = $1`, [id, value])).toBe(`payments_${column}_immutable`);
      }
      expect(await refusedBy(`UPDATE payments SET advance_for_student_id = $2 WHERE id = $1`, [id, otherStudent])).toBe('payments_advance_for_student_id_frozen');
    });

    it('payments: R232 nobody records a payment paid by their own guardian record or for their own child', async () => {
      expect(await tryAdd('payments', paymentRow({ recorded_by: parentClerk.userId, verified_by: parentClerk.userId }))).toBe('payments_own_child');
      expect(await tryAdd('payments', paymentRow({ recorded_by: parentClerk.userId, verified_by: parentClerk.userId, payer_name: null, payer_guardian_id: parentGuardian, advance_for_student_id: otherStudent }))).toBe('payments_own_child');
      expect(await tryAdd('payments', paymentRow({ recorded_by: parentClerk.userId, verified_by: parentClerk.userId, advance_for_student_id: otherStudent }))).toBeNull();
    });

    // ---- allocations ----------------------------------------------------------------------------

    it('payment_allocations: one statement raises each charge and lowers each payment by its sums; a full charge settles; the CHECKs refuse more', async () => {
      const [c1, c2] = [await charge(), await charge({ gross_amount: 500, amount: 500 })];
      const p = await add('payments', paymentRow({ amount: 1500 }));
      await run(
        `INSERT INTO payment_allocations (school_id, payment_id, charge_id, student_id, academic_year_id, amount)
         VALUES ($1, $2, $3, $5, $6, 1000), ($1, $2, $4, $5, $6, 300)`,
        [schoolId, p, c1, c2, student, year],
      );
      expect(await chargeState(c1)).toEqual({ allocated_amount: 1000, status: 'settled', settled: true });
      expect(await chargeState(c2)).toEqual({ allocated_amount: 300, status: 'open', settled: false });
      expect(await unallocated(p)).toBe(200);
      expect(await tryAdd('payment_allocations', allocation(p, c2, 100))).toBe('payment_allocations_live_key');
      const p2 = await add('payments', paymentRow());
      expect(await tryAdd('payment_allocations', allocation(p2, c2, 201))).toBe('charges_allocated_amount_check');
      expect(await tryAdd('payment_allocations', allocation(p2, c1, 1))).toBe('charges_allocated_amount_check');
      const c3 = await charge();
      expect(await tryAdd('payment_allocations', allocation(p, c3, 201))).toBe('payments_unallocated_amount_check');
      expect(await tryAdd('payment_allocations', allocation(p, c3, 100, { reversed_at: new Date() }))).toBe('payment_allocations_born_live');
      expect(await tryAdd('payment_allocations', allocation(p, c3, 100, { student_id: otherStudent }))).toBe('payment_allocations_charge_id_fkey');
      const id = await add('payment_allocations', allocation(p, c3, 100));
      expect(await refusedBy(`UPDATE payment_allocations SET amount = 1 WHERE id = $1`, [id])).toBe('payment_allocations_amount_immutable');
    });

    it('payment_allocations: R232 the acting user never applies money to their own child; a job (no actor) is not refused', async () => {
      // Migration 20261006150500_slice20_review_fixes: the check reads the acting user
      // (asms.actor_user_id, set by every request path that moves money), not the recorder, so a
      // recorder later linked as a guardian cannot freeze the system's advance applications. A
      // recorder paying their own child is still refused at the payment's insert (payments_own_child).
      const p = await add('payments', paymentRow({ recorded_by: parentClerk.userId, verified_by: parentClerk.userId, advance_for_student_id: otherStudent }));
      await run(`SELECT set_config('asms.actor_user_id', $1, true)`, [parentClerk.userId.toString()]);
      expect(await tryAdd('payment_allocations', allocation(p, await charge(), 100))).toBe('payment_allocations_own_child');
      await run(`SELECT set_config('asms.actor_user_id', '', true)`);
      expect(await tryAdd('payment_allocations', allocation(p, await charge(), 100))).toBeNull();
    });

    it('payment_allocations: reversing reopens the charge and restores the payment under asms.reversing_payment, which is put back; a live row may follow', async () => {
      const c = await charge();
      const p = await add('payments', paymentRow());
      const id = await add('payment_allocations', allocation(p, c, 1000));
      expect(await chargeState(c)).toMatchObject({ status: 'settled' });
      await run(`UPDATE payment_allocations SET reversed_at = now() WHERE id = $1`, [id]);
      expect(await chargeState(c)).toEqual({ allocated_amount: 0, status: 'open', settled: false });
      expect(await unallocated(p)).toBe(1000);
      expect(await reversing()).not.toBe('on');
      expect(await refusedBy(`UPDATE payment_allocations SET reversed_at = now() + interval '1 day' WHERE id = $1`, [id])).toBe('payment_allocations_reversed_at_frozen');
      // A credit's de-allocation keeps the part that stays as a new live row.
      await add('payment_allocations', allocation(p, c, 600));
      expect(await chargeState(c)).toEqual({ allocated_amount: 600, status: 'open', settled: false });
      // The setting is off again: a settled charge cannot be reopened by hand.
      await add('payment_allocations', allocation(await add('payments', paymentRow()), c, 400));
      expect(await refusedBy(`UPDATE charges SET allocated_amount = 0, status = 'open', settled_at = NULL WHERE id = $1`, [c])).toBe('charges_status_transition');
    });

    it('payment_allocations: R192 an admission-head allocation returns to its payment only by a void', async () => {
      const c = await charge({ fee_head_id: admissionHead, head_frequency: 'once', period: null });
      const p = await add('payments', paymentRow());
      const id = await add('payment_allocations', allocation(p, c, 500));
      expect(await refusedBy(`UPDATE payment_allocations SET reversed_at = now() WHERE id = $1`, [id])).toBe('payment_allocations_admission_reversal');
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 1000))).toBeNull();
    });

    // ---- reversals ------------------------------------------------------------------------------

    it('payment_reversals: a void by someone other than the recorder voids the payment and its receipt and reopens its charges', async () => {
      const c = await charge();
      const p = await add('payments', paymentRow());
      const a = await add('payment_allocations', allocation(p, c, 1000));
      const receipt = await add('receipts', { school_id: schoolId, payment_id: p, academic_year_id: year, receipt_no: 900, amount: 1000, issued_by: clerk.userId });
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 1000, { requested_by: clerk.userId }))).toBe('payment_reversals_not_self');
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 500))).toBe('payment_reversals_void_amount');
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 1000, { requested_by: parentClerk.userId }))).toBe('payment_reversals_own_child');
      await add('payment_reversals', reversal(p, 'void', 1000));
      expect(await one(`SELECT status, voided_at IS NOT NULL AS voided, unallocated_amount FROM payments WHERE id = $1`, [p])).toEqual({ status: 'voided', voided: true, unallocated_amount: 1000 });
      expect(await one(`SELECT voided_at IS NOT NULL AS voided FROM receipts WHERE id = $1`, [receipt])).toEqual({ voided: true });
      expect(await one(`SELECT reversed_at IS NOT NULL AS reversed FROM payment_allocations WHERE id = $1`, [a])).toEqual({ reversed: true });
      expect(await chargeState(c)).toEqual({ allocated_amount: 0, status: 'open', settled: false });
      expect(await reversing()).not.toBe('on');
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 1000))).toBe('payment_reversals_payment_voided');
      expect(await tryAdd('payment_reversals', reversal(p, 'refund', 100))).toBe('payment_reversals_payment_voided');
      expect(await tryAdd('payment_allocations', allocation(p, c, 100))).toBe('payment_allocations_payment_voided');
      expect(await refusedBy(`UPDATE receipts SET voided_at = now() + interval '1 day' WHERE id = $1`, [receipt])).toBe('receipts_voided_at_frozen');
    });

    it('payment_reversals: a refund lowers the unallocated amount and never below 0; a refund reversal restores it; a void waits while a refund stands', async () => {
      const p = await add('payments', paymentRow());
      expect(await tryAdd('payment_reversals', reversal(p, 'refund', 1001))).toBe('payments_unallocated_amount_check');
      expect(await tryAdd('payment_reversals', reversal(p, 'refund', 100, { approved_by: null }))).toBe('payment_reversals_approved_check');
      expect(await tryAdd('payment_reversals', reversal(p, 'refund', 100, { refund_method: 'carried_forward' }))).toBe('payment_reversals_refund_method_check');
      expect(await tryAdd('payment_reversals', reversal(p, 'refund', 100, { reason: '35202-1234567-1' }))).toBe('payment_reversals_reason_no_id_check');
      const refund = await add('payment_reversals', reversal(p, 'refund', 100));
      expect(await unallocated(p)).toBe(900);
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 1000, { requested_by: teacher.userId }))).toBe('payment_reversals_payment_has_refund');
      expect(await tryAdd('payment_reversals', reversal(p, 'refund_reversal', 50, { reverses_id: refund }))).toBe('payment_reversals_reverses_refund');
      expect(await tryAdd('payment_reversals', reversal(p, 'refund_reversal', 100))).toBe('payment_reversals_reverses_check');
      await add('payment_reversals', reversal(p, 'refund_reversal', 100, { reverses_id: refund }));
      expect(await unallocated(p)).toBe(1000);
      expect(await tryAdd('payment_reversals', reversal(p, 'refund_reversal', 100, { reverses_id: refund }))).toBe('payment_reversals_reverses_key');
      expect(await refusedBy(`UPDATE payment_reversals SET amount = 1 WHERE id = $1`, [refund])).toBe('payment_reversals_amount_immutable');
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 1000, { requested_by: teacher.userId }))).toBeNull();
    });

    it('payment_reversals: R251 a carry-forward lowers the payment and links to a payment of another year, both ways, by commit', async () => {
      const p = await add('payments', paymentRow());
      const r = await add('payment_reversals', reversal(p, 'carried_forward', 400, { requested_by: clerk.userId }));
      expect(await unallocated(p)).toBe(600);
      const target = (over: Row = {}) =>
        paymentRow({ academic_year_id: nextYear, method: 'carried_forward', carried_from_reversal_id: r, amount: 400, ...over });
      const voidOf = await add('payment_reversals', reversal(await add('payments', paymentRow()), 'void', 1000));
      expect(await tryAdd('payments', target({ carried_from_reversal_id: voidOf }))).toBe('payments_carried_from_check');
      const q = await add('payments', target());
      expect(await checkNow('payment_reversals_carry_forward_linked')).toBe('payment_reversals_carry_forward_linked');
      expect(await refusedBy(`UPDATE payment_reversals SET carried_to_payment_id = $2 WHERE id = $1`, [voidOf, q])).toBe('payment_reversals_carried_to_check');
      await run(`UPDATE payment_reversals SET carried_to_payment_id = $2 WHERE id = $1`, [r, q]);
      expect(await checkNow('payment_reversals_carry_forward_linked')).toBeNull();
      expect(await tryAdd('payments', target())).toBe('payments_carried_from_check');
      expect(await refusedBy(`UPDATE payment_reversals SET carried_to_payment_id = $2 WHERE id = $1`, [r, p])).toBe('payment_reversals_carried_to_payment_id_frozen');
      expect(await tryAdd('payment_reversals', reversal(p, 'void', 1000))).toBe('payment_reversals_payment_has_refund');
    });

    it('payments: R189 an unallocated remainder names its child by commit (checked now)', async () => {
      const p = await add('payments', paymentRow({ advance_for_student_id: null, recorded_by: teacher.userId, verified_by: teacher.userId }));
      expect(await checkNow('payments_advance_student_required')).toBe('payments_advance_student_required');
      await add('payment_allocations', allocation(p, await charge(), 1000));
      expect(await checkNow('payments_advance_student_required')).toBeNull();
    });

    // ---- receipts -------------------------------------------------------------------------------

    it('receipts and receipt_lines: one number per school and year; one receipt per payment; frozen; the advance line has no head', async () => {
      const receipt = (paymentId: bigint, receiptNo: number) =>
        ({ school_id: schoolId, payment_id: paymentId, academic_year_id: year, receipt_no: receiptNo, amount: 1000, issued_by: clerk.userId });
      const p = await add('payments', paymentRow());
      const id = await add('receipts', receipt(p, 1));
      expect(await tryAdd('receipts', receipt(await add('payments', paymentRow()), 1))).toBe('receipts_number_key');
      expect(await tryAdd('receipts', receipt(p, 2))).toBe('receipts_payment_key');
      expect(await tryAdd('receipts', receipt(await add('payments', paymentRow()), 0))).toBe('receipts_receipt_no_check');
      expect(await refusedBy(`UPDATE receipts SET receipt_no = 7 WHERE id = $1`, [id])).toBe('receipts_receipt_no_immutable');
      const line = (over: Row = {}): Row => ({ school_id: schoolId, receipt_id: id, academic_year_id: year, student_id: student, amount: 100, ...over });
      expect(await tryAdd('receipt_lines', line({ fee_head_name: 'Advance' }))).toBe('receipt_lines_advance_check');
      expect(await tryAdd('receipt_lines', line({ period }))).toBe('receipt_lines_advance_check');
      const advanceLine = await add('receipt_lines', line());
      expect(await tryAdd('receipt_lines', line({ academic_year_id: nextYear }))).toBe('receipt_lines_receipt_id_fkey');
      expect(await refusedBy(`UPDATE receipt_lines SET amount = 1 WHERE id = $1`, [advanceLine])).toBe('receipt_lines_amount_immutable');
    });

    // ---- custody and handovers --------------------------------------------------------------------

    it('cash_handovers: gathers the collector\'s own cash while open; never confirmed by the collector or opener; counted = expected + surplus - shortfall; one shortfall resolution', async () => {
      const h1 = await add('payments', paymentRow({ amount: 300 }));
      const h2 = await add('payments', paymentRow({ amount: 200 }));
      const handover = (over: Row = {}): Row => ({
        school_id: schoolId, collector_user_id: clerk.userId, collector_staff_id: clerk.staffId, opened_by: clerk.userId,
        expected_amount: 500, payment_count: 2, ...over,
      });
      expect(await tryAdd('cash_handovers', handover({ opened_by: principal.userId }))).toBe('cash_handovers_on_behalf_check');
      expect(await tryAdd('cash_handovers', handover({ collector_staff_id: teacher.staffId }))).toBe('cash_handovers_collector_user_id_fkey');
      expect(await tryAdd('cash_handovers', handover({ payment_count: 0, expected_amount: 0 }))).toBe('cash_handovers_expected_check');
      const id = await add('cash_handovers', handover());
      expect(await tryAdd('cash_handovers', handover())).toBe('cash_handovers_open_key');
      await run(`UPDATE payments SET handover_id = $2 WHERE id IN ($1, $3)`, [h1, id, h2]);
      expect(await checkNow('cash_handovers_expected_matches')).toBeNull();
      // Only the recorder's cash, only cash.
      const others = await add('payments', paymentRow({ recorded_by: teacher.userId, verified_by: teacher.userId }));
      expect(await refusedBy(`UPDATE payments SET handover_id = $2 WHERE id = $1`, [others, id])).toBe('payments_handover_id_fkey');
      const bank = await add('payments', paymentRow({ method: 'bank_transfer', reference: 'TX-1' }));
      expect(await refusedBy(`UPDATE payments SET handover_id = $2 WHERE id = $1`, [bank, id])).toBe('payments_handover_cash_check');
      expect(await refusedBy(`UPDATE payments SET handover_id = NULL WHERE id = $1`, [h1])).toBe('payments_handover_id_frozen');
      // §3.4: no void inside an open handover.
      expect(await tryAdd('payment_reversals', reversal(h1, 'void', 300))).toBe('payment_reversals_payment_in_handover');
      // R194: never the collector (here also the opener).
      const confirm = (by: bigint, counted: number, shortfall: number, surplus: number) =>
        refusedBy(
          `UPDATE cash_handovers SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, counted_amount = $3, shortfall_amount = $4, surplus_amount = $5 WHERE id = $1`,
          [id, by, counted, shortfall, surplus],
        );
      expect(await confirm(clerk.userId, 450, 50, 0)).toBe('cash_handovers_not_self_check');
      expect(await confirm(principal.userId, 450, 40, 0)).toBe('cash_handovers_counted_check');
      expect(await confirm(principal.userId, 500, 10, 10)).toBe('cash_handovers_counted_check');
      expect(await refusedBy(`UPDATE cash_handovers SET status = 'confirmed' WHERE id = $1`, [id])).toBe('cash_handovers_confirmed_check');
      await run(
        `UPDATE cash_handovers SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, counted_amount = 200, shortfall_amount = 300, surplus_amount = 0 WHERE id = $1`,
        [id, principal.userId],
      );
      expect(await refusedBy(`UPDATE cash_handovers SET counted_amount = 500, shortfall_amount = 0 WHERE id = $1`, [id])).toBe('cash_handovers_counted_amount_frozen');
      // A confirmed handover takes no more payments; a void after confirmation is allowed.
      const late = await add('payments', paymentRow({ amount: 50 }));
      expect(await refusedBy(`UPDATE payments SET handover_id = $2 WHERE id = $1`, [late, id])).toBe('payments_handover_open');
      const voidOfH1 = await add('payment_reversals', reversal(h1, 'void', 300));
      const voidElsewhere = await add('payment_reversals', reversal(await add('payments', paymentRow()), 'void', 1000));
      const resolve = (resolution: string, over: Row = {}) => {
        const values: Row = { shortfall_resolution: resolution, shortfall_resolved_at: new Date(), shortfall_resolved_by: principal.userId, shortfall_resolution_reason: 'Counted again', ...over };
        const columns = Object.keys(values);
        return refusedBy(
          `UPDATE cash_handovers SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...Object.values(values)],
        );
      };
      expect(await resolve('written_off')).toBe('cash_handovers_resolution_check');
      const wrongExpense = await add('expenses', {
        school_id: schoolId, expense_no: 9001, category: 'stationery', amount: 300, spent_on: today, description: 'Chalk', method: 'cash', status: 'recorded', recorded_by: principal.userId,
      });
      expect(await resolve('written_off', { shortfall_expense_id: wrongExpense })).toBe('cash_handovers_shortfall_expense');
      expect(await resolve('explained_by_void', { shortfall_reversal_id: voidElsewhere })).toBe('cash_handovers_shortfall_reversal');
      expect(await resolve('explained_by_void', { shortfall_reversal_id: voidOfH1 })).toBeNull();
      expect(await resolve('recovered')).toBeNull();
      await run(
        `UPDATE cash_handovers SET shortfall_resolution = 'recovered', shortfall_resolved_at = now(), shortfall_resolved_by = $2, shortfall_resolution_reason = 'Paid back' WHERE id = $1`,
        [id, principal.userId],
      );
      expect(await resolve('written_off')).toBe('cash_handovers_shortfall_resolution_frozen');
    });

    // ---- payroll --------------------------------------------------------------------------------

    const structureRow = (staffId: bigint, over: Row = {}): Row => ({
      school_id: schoolId, staff_id: staffId, basic: 30000, effective_from: '2026-01-01', reason: 'Hired', created_by: principal.userId, ...over,
    });

    it('salary_structures: one active structure per day; closed once; frozen; R235/R253 never one\'s own except the sole principal, self_approved', async () => {
      const id = await add('salary_structures', structureRow(teacher.staffId));
      expect(await tryAdd('salary_structures', structureRow(teacher.staffId, { effective_from: '2026-03-01' }))).toBe('salary_structures_live_excl');
      await run(`UPDATE salary_structures SET ended_on = '2026-02-28' WHERE id = $1`, [id]);
      expect(await tryAdd('salary_structures', structureRow(teacher.staffId, { effective_from: '2026-03-01' }))).toBeNull();
      expect(await refusedBy(`UPDATE salary_structures SET ended_on = '2026-02-27' WHERE id = $1`, [id])).toBe('salary_structures_ended_on_frozen');
      expect(await refusedBy(`UPDATE salary_structures SET basic = 1 WHERE id = $1`, [id])).toBe('salary_structures_basic_immutable');
      expect(await refusedBy(`UPDATE salary_structures SET status = 'superseded' WHERE id = $1`, [id])).toBe('salary_structures_superseded_check');
      expect(await tryAdd('salary_structures', structureRow(teacher.staffId, { basic: -1, effective_from: '2027-01-01' }))).toBe('salary_structures_basic_check');
      // Own structure.
      expect(await tryAdd('salary_structures', structureRow(clerk.staffId, { created_by: clerk.userId }))).toBe('salary_structures_not_self');
      expect(await tryAdd('salary_structures', structureRow(principal.staffId))).toBe('salary_structures_not_self');
      expect(await tryAdd('salary_structures', structureRow(principal.staffId, { self_approved: true }))).toBeNull();
      expect(await tryAdd('salary_structures', structureRow(clerk.staffId, { self_approved: true }))).toBe('salary_structures_self_approved_unwarranted');
      await run(`SAVEPOINT two_principals`);
      await run(`UPDATE users SET status = 'active' WHERE school_id = $1 AND id = $2`, [schoolId, secondPrincipal.userId]);
      expect(await tryAdd('salary_structures', structureRow(principal.staffId, { self_approved: true }))).toBe('salary_structures_not_self');
      await run(`ROLLBACK TO SAVEPOINT two_principals`);
    });

    it('salary_structure_components: positive amounts, positions 0-19 unique per structure, unique names per kind; append-only', async () => {
      const s = await add('salary_structures', structureRow(clerk.staffId));
      const component = (over: Row = {}): Row => ({ school_id: schoolId, structure_id: s, kind: 'allowance', name: 'House rent', amount: 5000, position: 0, ...over });
      const id = await add('salary_structure_components', component());
      expect(await tryAdd('salary_structure_components', component({ position: 1 }))).toBe('salary_structure_components_name_key');
      expect(await tryAdd('salary_structure_components', component({ name: 'Medical' }))).toBe('salary_structure_components_position_key');
      expect(await tryAdd('salary_structure_components', component({ name: 'Medical', position: 20 }))).toBe('salary_structure_components_position_check');
      expect(await tryAdd('salary_structure_components', component({ name: 'Medical', position: 1, amount: 0 }))).toBe('salary_structure_components_amount_check');
      expect(await refusedBy(`UPDATE salary_structure_components SET amount = 1 WHERE id = $1`, [id])).toBe('salary_structure_components_amount_immutable');
    });

    const advanceRow = (over: Row = {}): Row => ({
      school_id: schoolId, staff_id: clerk.staffId, amount: 6000, granted_on: '2026-07-15', recover_from: '2026-08',
      instalment_amount: 2000, approved_by: principal.userId, paid_method: 'cash', ...over,
    });

    it('salary_advances: instalment within the amount; never granted or written off for oneself; written off once', async () => {
      expect(await tryAdd('salary_advances', advanceRow({ instalment_amount: 6001 }))).toBe('salary_advances_instalment_amount_check');
      expect(await tryAdd('salary_advances', advanceRow({ paid_method: 'carried_forward' }))).toBe('salary_advances_paid_method_check');
      expect(await tryAdd('salary_advances', advanceRow({ recover_from: '2026-13' }))).toBe('salary_advances_recover_from_check');
      expect(await tryAdd('salary_advances', advanceRow({ approved_by: clerk.userId }))).toBe('salary_advances_not_self');
      expect(await tryAdd('salary_advances', advanceRow({ staff_id: principal.staffId }))).toBe('salary_advances_not_self');
      const id = await add('salary_advances', advanceRow());
      const writeOff = (by: bigint) =>
        refusedBy(`UPDATE salary_advances SET status = 'written_off', written_off_at = now(), written_off_by = $2, write_off_reason = 'Left' WHERE id = $1`, [id, by]);
      expect(await writeOff(clerk.userId)).toBe('salary_advances_not_self');
      expect(await refusedBy(`UPDATE salary_advances SET status = 'recovered' WHERE id = $1`, [id])).toBe('salary_advances_status_check');
      expect(await refusedBy(`UPDATE salary_advances SET amount = 1 WHERE id = $1`, [id])).toBe('salary_advances_amount_immutable');
      expect(await writeOff(principal.userId)).toBeNull();
    });

    const runRow = (yearMonth: string): Row => ({ school_id: schoolId, year_month: yearMonth, working_days: 26, prepared_by: principal.userId });
    const payslipRow = (runId: bigint, structureId: bigint, over: Row = {}): Row => ({
      school_id: schoolId, run_id: runId, staff_id: clerk.staffId, structure_id: structureId, employed_working_days: 26, basic: 30000,
      allowances_total: 5000, deductions_total: 1000, unpaid_days: 1, unmarked_days: 0, absence_deduction: 1153, advance_recovery: 2000,
      adjustment_total: 0, net: 30847, ...over,
    });
    const finalise = (runId: bigint) =>
      run(`UPDATE payroll_runs SET status = 'finalised', finalised_at = now(), finalised_by = $2 WHERE id = $1`, [runId, principal.userId]);

    it('payroll_runs and payslips: one run a month; net is the formula and never negative; a draft is rewritten, a finalised run is frozen but for paying', async () => {
      const s = await add('salary_structures', structureRow(clerk.staffId, { effective_from: '2025-01-01', ended_on: '2025-12-31' }));
      const r = await add('payroll_runs', runRow('2026-05'));
      expect(await tryAdd('payroll_runs', runRow('2026-05'))).toBe('payroll_runs_month_key');
      expect(await refusedBy(`UPDATE payroll_runs SET skipped = '[{"staffId":"1","reason":"no_structure","name":"x"}]' WHERE id = $1`, [r])).toBe('payroll_runs_skipped_check');
      expect(await tryAdd('payslips', payslipRow(r, s, { net: 30848 }))).toBe('payslips_net_check');
      expect(await tryAdd('payslips', payslipRow(r, s, { adjustment_total: -40000, net: -9153 }))).toBe('payslips_net_check');
      expect(await tryAdd('payslips', payslipRow(r, s, { unpaid_days: 27 }))).toBe('payslips_days_check');
      expect(await tryAdd('payslips', payslipRow(r, await add('salary_structures', structureRow(teacher.staffId, { effective_from: '2025-01-01', ended_on: '2025-12-31' }))))).toBe('payslips_structure_id_fkey');
      const slip = await add('payslips', payslipRow(r, s));
      expect(await tryAdd('payslips', payslipRow(r, s))).toBe('payslips_run_staff_key');
      // A draft is rewritten in place, but not paid.
      expect(await refusedBy(`UPDATE payslips SET basic = 29000, net = 29847 WHERE id = $1`, [slip])).toBeNull();
      const pay = `UPDATE payslips SET status = 'paid', paid_on = $2, paid_method = 'cash', paid_by = $3 WHERE id = $1`;
      expect(await refusedBy(pay, [slip, today, principal.userId])).toBe('payslips_run_not_finalised');
      await finalise(r);
      expect(await refusedBy(`UPDATE payroll_runs SET status = 'draft' WHERE id = $1`, [r])).toBe('payroll_runs_status_transition');
      expect(await refusedBy(`UPDATE payroll_runs SET working_days = 20 WHERE id = $1`, [r])).toBe('payroll_runs_working_days_frozen');
      expect(await refusedBy(`UPDATE payslips SET basic = 29000, net = 29847 WHERE id = $1`, [slip])).toBe('payslips_run_finalised');
      expect(await tryAdd('payslips', payslipRow(r, s, { staff_id: teacher.staffId }))).toBe('payslips_run_finalised');
      expect(await refusedBy(`UPDATE payslips SET status = 'paid', paid_on = $2, paid_method = 'carried_forward', paid_by = $3 WHERE id = $1`, [slip, today, principal.userId])).toBe('payslips_paid_check');
      await run(pay, [slip, today, principal.userId]);
      expect(await refusedBy(`UPDATE payslips SET paid_on = '2020-01-01' WHERE id = $1`, [slip])).toBe('payslips_paid_on_frozen');
    });

    it('payslip_lines: written and recomputed only while the run is a draft; adjustments are kept, signed, never one\'s own, and correct a finalised payslip', async () => {
      const s = await add('salary_structures', structureRow(clerk.staffId, { effective_from: '2024-01-01', ended_on: '2024-12-31' }));
      const earlier = await add('payroll_runs', runRow('2024-06'));
      const earlierSlip = await add('payslips', payslipRow(earlier, s));
      const draft = await add('payroll_runs', runRow('2024-07'));
      const slip = await add('payslips', payslipRow(draft, s));
      const line = (over: Row = {}): Row => ({ school_id: schoolId, payslip_id: slip, staff_id: clerk.staffId, kind: 'allowance', name: 'House rent', amount: 5000, ...over });
      const adjustment = (over: Row = {}) => line({ kind: 'adjustment', name: 'Arrears', amount: -500, reason: 'Overpaid in June', created_by: principal.userId, ...over });
      const computed = await add('payslip_lines', line());
      expect(await tryAdd('payslip_lines', line({ amount: 0 }))).toBe('payslip_lines_amount_check');
      expect(await tryAdd('payslip_lines', adjustment({ amount: 0 }))).toBe('payslip_lines_amount_check');
      expect(await tryAdd('payslip_lines', adjustment({ reason: null }))).toBe('payslip_lines_adjustment_check');
      expect(await tryAdd('payslip_lines', adjustment({ created_by: clerk.userId }))).toBe('payslip_adjust_not_self');
      expect(await tryAdd('payslip_lines', adjustment({ adjusts_payslip_id: earlierSlip }))).toBe('payslip_lines_adjusts_finalised');
      await finalise(earlier);
      const adjusting = await add('payslip_lines', adjustment({ adjusts_payslip_id: earlierSlip }));
      expect(await refusedBy(`DELETE FROM payslip_lines WHERE id = $1`, [computed])).toBeNull();
      expect(await refusedBy(`DELETE FROM payslip_lines WHERE id = $1`, [adjusting])).toBe('payslip_lines_adjustment_kept');
      expect(await refusedBy(`UPDATE payslip_lines SET amount = 1 WHERE id = $1`, [computed])).toBe('payslip_lines_amount_immutable');
      await finalise(draft);
      expect(await tryAdd('payslip_lines', line())).toBe('payslip_lines_draft_only');
      expect(await refusedBy(`DELETE FROM payslip_lines WHERE id = $1`, [computed])).toBe('payslip_lines_draft_only');
    });

    it('salary_advance_recoveries: only by a finalised payslip, from an open advance, raising recovered_amount until it is recovered', async () => {
      const s = await add('salary_structures', structureRow(clerk.staffId, { effective_from: '2023-01-01', ended_on: '2023-12-31' }));
      const slips: bigint[] = [];
      for (const month of ['2023-01', '2023-02', '2023-03', '2023-04']) {
        const r = await add('payroll_runs', runRow(month));
        slips.push(await add('payslips', payslipRow(r, s)));
        if (month !== '2023-04') await finalise(r);
      }
      const advance = await add('salary_advances', advanceRow());
      const recovery = (payslipId: bigint, amount: number): Row => ({ school_id: schoolId, advance_id: advance, payslip_id: payslipId, staff_id: clerk.staffId, amount });
      expect(await tryAdd('salary_advance_recoveries', recovery(slips[3]!, 2000))).toBe('salary_advance_recoveries_run_finalised');
      expect(await tryAdd('salary_advance_recoveries', recovery(slips[0]!, 6001))).toBe('salary_advances_recovered_check');
      expect(await tryAdd('salary_advance_recoveries', { ...recovery(slips[0]!, 1), staff_id: teacher.staffId })).toMatch(/^salary_advance_recoveries_(advance|payslip)_id_fkey$/);
      await add('salary_advance_recoveries', recovery(slips[0]!, 2000));
      expect(await one(`SELECT recovered_amount, status FROM salary_advances WHERE id = $1`, [advance])).toEqual({ recovered_amount: 2000, status: 'open' });
      expect(await tryAdd('salary_advance_recoveries', recovery(slips[0]!, 1))).toBe('salary_advance_recoveries_advance_payslip_key');
      await add('salary_advance_recoveries', recovery(slips[1]!, 4000));
      expect(await one(`SELECT recovered_amount, status FROM salary_advances WHERE id = $1`, [advance])).toEqual({ recovered_amount: 6000, status: 'recovered' });
      expect(await tryAdd('salary_advance_recoveries', recovery(slips[2]!, 1))).toBe('salary_advance_recoveries_advance_open');
    });

    // ---- rule 4 -----------------------------------------------------------------------------------

    it('rule 4: no wave J row is ever deleted', async () => {
      for (const table of [
        'payments', 'payment_allocations', 'receipts', 'receipt_lines', 'payment_reversals', 'cash_handovers',
        'salary_structures', 'salary_structure_components', 'salary_advances', 'payroll_runs', 'payslips',
        'salary_advance_recoveries',
      ]) {
        expect(await one(`SELECT count(*)::int AS n FROM ${table} WHERE school_id = $1`, [schoolId])).not.toEqual({ n: 0 });
        expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_no_delete`);
      }
    });
  });

  describe('at commit (deferred constraint triggers)', () => {
    /** Runs `work` in a transaction of its own and returns the constraint COMMIT is refused by, or null. */
    const commitRefusal = async (work: (q: (sql: string, params?: unknown[]) => Promise<bigint>) => Promise<void>): Promise<string | null> => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query('BEGIN');
        await work(async (sql, params = []) => {
          const row = (await client.query(sql, params)).rows[0] as Row | undefined;
          return row ? BigInt(row.id as string) : 0n;
        });
        await client.query('COMMIT');
        return null;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        return constraintOf(error);
      } finally {
        await client.end();
      }
    };

    it('payments: R189 a remainder without its child is refused at commit', async () => {
      expect(
        await commitRefusal(async (q) => {
          await q(...insertSql('payments', paymentRow({ advance_for_student_id: null })));
        }),
      ).toBe('payments_advance_student_required');
    });

    it('payment_reversals: R251 a carry-forward left without its target payment is refused at commit', async () => {
      expect(
        await commitRefusal(async (q) => {
          const p = await q(...insertSql('payments', paymentRow()));
          await q(...insertSql('payment_reversals', {
            school_id: schoolId, payment_id: p, academic_year_id: year, kind: 'carried_forward', amount: 400, reason: 'Next session', requested_by: clerk.userId,
          }));
        }),
      ).toBe('payment_reversals_carry_forward_linked');
    });

    it('cash_handovers: §3.4 an expected amount that is not the gathered payments\' sum is refused at commit', async () => {
      expect(
        await commitRefusal(async (q) => {
          const p = await q(...insertSql('payments', paymentRow({ recorded_by: teacher.userId, verified_by: teacher.userId, amount: 700 })));
          const h = await q(...insertSql('cash_handovers', {
            school_id: schoolId, collector_user_id: teacher.userId, collector_staff_id: teacher.staffId, opened_by: teacher.userId, expected_amount: 999, payment_count: 1,
          }));
          await q(`UPDATE payments SET handover_id = $2 WHERE id = $1 RETURNING id`, [p, h]);
        }),
      ).toBe('cash_handovers_expected_matches');
    });
  });
});
