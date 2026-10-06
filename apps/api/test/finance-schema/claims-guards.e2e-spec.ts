// The wave K money discipline in the database (phase-3-financial.md rule 0.20-0.21, §3.2, §4
// "Claims", R196-R200, R243; decision item 21): a claim is born pending by a live login link of the
// child, its statement is frozen, its image is set once while pending, its decision is history,
// the verifier is never of the family, a verification names the payment it recorded, and a void of
// that payment reopens it under asms.reversing_payment (the wave K hook in
// asms_payment_reversal_apply). Each statement is raw SQL inside one transaction that is rolled
// back, behind its own savepoint, so nothing here changes or removes a row even if a guard were
// missing (an exemption in guardrails/no-truncate.spec.ts). Fixtures are committed through the
// guarded client first, in a school of their own.
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

/** An UPDATE of one row from column/value pairs. */
const updateSql = (table: string, id: bigint, values: Row): [string, unknown[]] => {
  const columns = Object.keys(values);
  return [`UPDATE ${table} SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(values)]];
};

describe('wave K claim guards (raw SQL)', () => {
  const db = testDb();
  let schoolId: bigint;
  let principal: TestSchoolUser;
  /** Holds payment.verify in the service; here, any staff user of no family of the student. */
  let clerk: TestSchoolUser;
  /** Office staff whose own guardian record submits the claims (a guardian-staff, R197). */
  let submitterStaff: TestSchoolUser;
  /** Office staff who is another live guardian of the student. */
  let parentClerk: TestSchoolUser;
  /** Office staff whose guardian record was merged into the submitter's. */
  let mergedClerk: TestSchoolUser;
  let student: bigint;
  let submitter: bigint;
  let unlinked: bigint;
  let noLogin: bigint;
  let merged: bigint;
  const today = isoDay();
  const yesterday = isoDay(-1);
  let keySeq = 0;

  beforeAll(async () => {
    const school = await createSchool();
    schoolId = school.id;
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    clerk = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    submitterStaff = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    parentClerk = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    mergedClerk = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const { section } = await createClassWithSection(db, school);
    const s = await createStudent(db, school);
    student = s.id;
    await enrol(db, school, s, section);
    const [g1, g2, g3, g4, g5] = [
      await createGuardian(db, school), await createGuardian(db, school), await createGuardian(db, school),
      await createGuardian(db, school), await createGuardian(db, school),
    ];
    submitter = g1.id;
    unlinked = g3.id;
    noLogin = g4.id;
    merged = g5.id;
    await linkGuardian(db, school, s, g1, { canLogin: true });
    await linkGuardian(db, school, s, g2, { canLogin: true, isPrimaryContact: false, isFeePayer: false, relationship: 'mother' });
    await linkGuardian(db, school, s, g4, { canLogin: false, isPrimaryContact: false, isFeePayer: false, relationship: 'other' });
    await db.user.updateMany({ where: { schoolId, id: submitterStaff.userId }, data: { guardianId: g1.id } });
    await db.user.updateMany({ where: { schoolId, id: parentClerk.userId }, data: { guardianId: g2.id } });
    await db.user.updateMany({ where: { schoolId, id: mergedClerk.userId }, data: { guardianId: g5.id } });
  });

  afterAll(() => closeTestDb());

  /** A fresh staged-upload key of this school (a ULID of Crockford digits). */
  const imageKey = () => `${schoolId}/01ARZ3NDEKTSV4RRFFQ69G${String(keySeq++).padStart(4, '0')}.jpg`;
  const image = (): Row => ({ image_object_key: imageKey(), image_mime: 'image/jpeg', image_size_bytes: 120_000 });
  const claimRow = (over: Row = {}): Row => ({
    school_id: schoolId, student_id: student, guardian_id: submitter, method: 'bank_transfer', claimed_amount: 1000,
    paid_on: today, reference: 'TX-100', ...image(), ...over,
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
    const run = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await pg.query(sql, params)).rows as Row[];
    const add = async (table: string, values: Row): Promise<bigint> => {
      const [sql, params] = insertSql(table, values);
      return BigInt((await run(sql, params))[0]?.id as string);
    };
    const tryAdd = (table: string, values: Row) => refusedBy(...insertSql(table, values));
    const tryUpdate = (id: bigint, values: Row) => refusedBy(...updateSql('payment_claims', id, values));
    const update = (id: bigint, values: Row) => run(...updateSql('payment_claims', id, values));
    const one = async (sql: string, params: unknown[] = []) => (await run(sql, params))[0];
    const reversing = async () => (await one(`SELECT coalesce(current_setting('asms.reversing_payment', true), '') AS v`))?.v;

    /** The payment a verification records: the claim's method, amount and date, paid by the submitter, naming the claim. */
    const paymentRow = (over: Row = {}): Row => ({
      school_id: schoolId, academic_year_id: null, payer_guardian_id: submitter, method: 'bank_transfer', amount: 1000,
      received_on: today, reference: 'TX-100', recorded_by: clerk.userId, verified_by: clerk.userId, advance_for_student_id: student, ...over,
    });
    let year: bigint;
    /** A payment recorded for claim `claimId` (null: a counter payment). */
    const payment = (claimId: bigint | null, over: Row = {}) => add('payments', { ...paymentRow(over), academic_year_id: year, claim_id: claimId });
    const verify = (paymentId: bigint, over: Row = {}): Row => ({
      status: 'verified', decided_by: clerk.userId, decided_at: new Date(), verified_amount: 1000, payment_id: paymentId, ...over,
    });

    beforeAll(async () => {
      pg = new Client({ connectionString: process.env.DATABASE_URL });
      await pg.connect();
      await pg.query('BEGIN');
      year = BigInt((await one(`SELECT academic_year_id AS id FROM enrolments WHERE school_id = $1 AND student_id = $2`, [schoolId, student]))?.id as string);
    });

    afterAll(async () => {
      await pg.query('ROLLBACK');
      await pg.end();
    });

    it('insert: amount, method, text, date and image CHECKs; born pending by a live login link of the child', async () => {
      expect(await tryAdd('payment_claims', claimRow({ claimed_amount: 0 }))).toBe('payment_claims_claimed_amount_check');
      expect(await tryAdd('payment_claims', claimRow({ method: 'cash' }))).toBe('payment_claims_method_check');
      expect(await tryAdd('payment_claims', claimRow({ method: 'carried_forward' }))).toBe('payment_claims_method_check');
      expect(await tryAdd('payment_claims', claimRow({ paid_on: isoDay(1) }))).toBe('payment_claims_dates_check');
      expect(await tryAdd('payment_claims', claimRow({ reference: '3520212345671' }))).toBe('payment_claims_reference_no_id_check');
      expect(await tryAdd('payment_claims', claimRow({ note: 'CNIC 35202-1234567-1' }))).toBe('payment_claims_note_no_id_check');
      expect(await tryAdd('payment_claims', claimRow({ note: ' padded' }))).toBe('payment_claims_note_check');
      expect(await tryAdd('payment_claims', claimRow({ image_mime: null }))).toBe('payment_claims_image_check');
      expect(await tryAdd('payment_claims', claimRow({ image_object_key: `${schoolId + 1n}/01ARZ3NDEKTSV4RRFFQ69G5FAV.jpg` }))).toBe('payment_claims_image_check');
      expect(await tryAdd('payment_claims', claimRow({ image_size_bytes: 5_242_881 }))).toBe('payment_claims_image_check');
      expect(await tryAdd('payment_claims', claimRow({ status: 'rejected', decided_by: clerk.userId, decided_at: new Date(), decision_reason: 'No' }))).toBe('payment_claims_born_pending');
      expect(await tryAdd('payment_claims', claimRow({ reopened_at: new Date() }))).toBe('payment_claims_born_pending');
      expect(await tryAdd('payment_claims', claimRow({ guardian_id: unlinked }))).toBe('payment_claims_guardian_link');
      expect(await tryAdd('payment_claims', claimRow({ guardian_id: noLogin }))).toBe('payment_claims_guardian_link');
      const key = imageKey();
      await add('payment_claims', claimRow({ image_object_key: key }));
      expect(await tryAdd('payment_claims', claimRow({ image_object_key: key }))).toBe('payment_claims_image_object_key_key');
      expect(await tryAdd('payment_claims', claimRow({ image_object_key: null, image_mime: null, image_size_bytes: null, reference: null, note: null }))).toBeNull();
    });

    it('the statement is frozen; R243 the image is set once, and only while pending', async () => {
      const id = await add('payment_claims', claimRow({ image_object_key: null, image_mime: null, image_size_bytes: null }));
      for (const [column, value] of [['claimed_amount', 5], ['paid_on', yesterday], ['method', 'jazzcash'], ['reference', 'TX-9'], ['guardian_id', unlinked]] as const) {
        expect(await tryUpdate(id, { [column]: value })).toBe(`payment_claims_${column}_immutable`);
      }
      await update(id, image());
      expect(await tryUpdate(id, image())).toBe('payment_claims_image_object_key_frozen');
      const imageless = await add('payment_claims', claimRow({ image_object_key: null, image_mime: null, image_size_bytes: null }));
      await update(imageless, { status: 'rejected', decided_by: clerk.userId, decided_at: new Date(), decision_reason: 'Unreadable' });
      expect(await tryUpdate(imageless, image())).toBe('payment_claims_image_not_pending');
    });

    it('decisions: each terminal status carries its own columns; a decided claim is history', async () => {
      const id = await add('payment_claims', claimRow());
      expect(await tryUpdate(id, { status: 'rejected', decided_by: clerk.userId, decided_at: new Date() })).toBe('payment_claims_decided_check');
      expect(await tryUpdate(id, { status: 'withdrawn', decided_at: new Date() })).toBe('payment_claims_decided_check');
      expect(await tryUpdate(id, { status: 'expired', decided_at: new Date() })).toBe('payment_claims_image_status_check');
      expect(await tryUpdate(id, { decided_by: clerk.userId, decided_at: new Date() })).toBe('payment_claims_decided_check');
      expect(await tryUpdate(id, { status: 'rejected', decided_by: clerk.userId, decided_at: new Date(), decision_reason: 'No', verified_amount: 1000 })).toBe('payment_claims_verified_check');
      await update(id, { status: 'rejected', decided_by: clerk.userId, decided_at: new Date(), decision_reason: 'Not on the statement' });
      expect(await tryUpdate(id, { decision_reason: 'Changed my mind' })).toBe('payment_claims_decision_frozen');
      expect(await tryUpdate(id, { status: 'pending', decided_by: null, decided_at: null, decision_reason: null })).toBe('payment_claims_decision_frozen');
      expect(await tryUpdate(id, { status: 'pending' })).toBe('payment_claims_status_transition');
      expect(await tryUpdate(id, { status: 'withdrawn' })).toBe('payment_claims_status_transition');
      // The submitter withdraws (no reason needed); an image-less claim expires (the system).
      const mine = await add('payment_claims', claimRow());
      expect(await tryUpdate(mine, { status: 'withdrawn', decided_by: submitterStaff.userId, decided_at: new Date() })).toBeNull();
      const imageless = await add('payment_claims', claimRow({ image_object_key: null, image_mime: null, image_size_bytes: null }));
      await update(imageless, { status: 'expired', decided_at: new Date() });
      expect(await tryUpdate(imageless, { reopened_at: new Date() })).toBe('payment_claims_reopened_at_frozen');
    });

    it('verification: R196/R200 an image, the amount at most claimed, a reason for a lower amount or a corrected date', async () => {
      const id = await add('payment_claims', claimRow());
      const p = await payment(id);
      expect(await tryUpdate(id, verify(p, { payment_id: null }))).toBe('payment_claims_verified_check');
      expect(await tryUpdate(id, verify(p, { verified_amount: null }))).toBe('payment_claims_payment_matches');
      expect(await tryUpdate(id, verify(await payment(id, { amount: 1200 }), { verified_amount: 1200 }))).toBe('payment_claims_verified_amount_check');
      expect(await tryUpdate(id, verify(await payment(id, { amount: 800 }), { verified_amount: 800 }))).toBe('payment_claims_verified_reason_check');
      expect(await tryUpdate(id, verify(await payment(id, { amount: 800 }), { verified_amount: 800, decision_reason: 'Slip shows 800' }))).toBeNull();
      // Decision item 21: a corrected date needs a reason, is on or before the claim's day, and differs.
      expect(await tryUpdate(id, verify(await payment(id, { received_on: yesterday }), { verified_paid_on: yesterday }))).toBe('payment_claims_verified_reason_check');
      expect(await tryUpdate(id, verify(await payment(id, { received_on: yesterday }), { verified_paid_on: yesterday, decision_reason: 'Slip dated yesterday' }))).toBeNull();
      expect(await tryUpdate(id, verify(p, { verified_paid_on: today, decision_reason: 'Same day' }))).toBe('payment_claims_dates_check');
      expect(await tryUpdate(id, verify(await payment(id, { received_on: isoDay(1) }), { verified_paid_on: isoDay(1), decision_reason: 'Tomorrow' }))).toBe('payment_claims_dates_check');
      const imageless = await add('payment_claims', claimRow({ image_object_key: null, image_mime: null, image_size_bytes: null }));
      expect(await tryUpdate(imageless, verify(await payment(imageless)))).toBe('payment_claims_image_status_check');
    });

    it('verification: R196 the payment named is the one recorded for this claim, and serves one claim', async () => {
      const id = await add('payment_claims', claimRow());
      expect(await tryUpdate(id, verify(await payment(id, { amount: 900 })))).toBe('payment_claims_payment_matches');
      expect(await tryUpdate(id, verify(await payment(id, { method: 'jazzcash' })))).toBe('payment_claims_payment_matches');
      expect(await tryUpdate(id, verify(await payment(id, { received_on: yesterday })))).toBe('payment_claims_payment_matches');
      expect(await tryUpdate(id, verify(await payment(id, { verified_by: principal.userId, recorded_by: principal.userId })))).toBe('payment_claims_payment_matches');
      expect(await tryUpdate(id, verify(await payment(id, { payer_guardian_id: null, payer_name: 'Walk-in parent' })))).toBe('payment_claims_payment_matches');
      const voided = await payment(id);
      await add('payment_reversals', { school_id: schoolId, payment_id: voided, academic_year_id: year, kind: 'void', amount: 1000, reason: 'Wrong slip', requested_by: principal.userId });
      expect(await tryUpdate(id, verify(voided))).toBe('payment_claims_payment_matches');
      const p = await payment(id);
      await update(id, verify(p));
      // Another claim never names it: the payment carries its claim (payments.claim_id).
      const other = await add('payment_claims', claimRow());
      expect(await tryUpdate(other, verify(p))).toBe('payment_claims_payment_matches');
      expect(await tryUpdate(other, verify(await payment(null)))).toBe('payment_claims_payment_matches');
    });

    it('payments.claim_id: set at insert only, never changed, only on a deposit method', async () => {
      const id = await add('payment_claims', claimRow());
      expect(await tryAdd('payments', { ...paymentRow({ method: 'cash', reference: null, claim_id: id }), academic_year_id: year })).toBe('payments_claim_method_check');
      const p = await payment(id);
      const plain = await payment(null);
      expect(await refusedBy(`UPDATE payments SET claim_id = NULL WHERE id = $1`, [p])).toBe('payments_claim_id_immutable');
      expect(await refusedBy(`UPDATE payments SET claim_id = $2 WHERE id = $1`, [plain, id])).toBe('payments_claim_id_immutable');
    });

    it('R197 nobody verifies or rejects a claim of their own family (submitter, merge-resolved, any live guardian of the child)', async () => {
      const id = await add('payment_claims', claimRow());
      const p = await payment(id);
      expect(await tryUpdate(id, verify(p, { decided_by: submitterStaff.userId }))).toBe('payment_claims_not_self');
      expect(await tryUpdate(id, verify(p, { decided_by: parentClerk.userId }))).toBe('payment_claims_not_self');
      expect(await tryUpdate(id, { status: 'rejected', decided_by: parentClerk.userId, decided_at: new Date(), decision_reason: 'No' })).toBe('payment_claims_not_self');
      // The merged clerk's record is folded into the submitter's: the same family.
      expect(await tryUpdate(id, verify(p, { decided_by: mergedClerk.userId }))).toBe('payment_claims_payment_matches');
      await run(`UPDATE guardians SET status = 'merged', merged_into_id = $2 WHERE school_id = $3 AND id = $1`, [merged, submitter, schoolId]);
      expect(await tryUpdate(id, verify(p, { decided_by: mergedClerk.userId }))).toBe('payment_claims_not_self');
      expect(await tryUpdate(id, verify(p))).toBeNull();
    });

    it('R191 a void of the claim\'s payment returns it to pending with reopened_at, its decision cleared; only a void may', async () => {
      const id = await add('payment_claims', claimRow());
      const p = await payment(id);
      await update(id, verify(p));
      // By hand: refused without the setting, and the reopen must move reopened_at.
      const reopen = { status: 'pending', payment_id: null, verified_amount: null, decided_by: null, decided_at: null };
      expect(await tryUpdate(id, { ...reopen, reopened_at: new Date() })).toBe('payment_claims_status_transition');
      await run(`SAVEPOINT reversing`);
      await run(`SELECT set_config('asms.reversing_payment', 'on', true)`);
      expect(await tryUpdate(id, reopen)).toBe('payment_claims_reopened_at_required');
      await run(`ROLLBACK TO SAVEPOINT reversing`);
      expect(await tryUpdate(id, { payment_id: null })).toBe('payment_claims_decision_frozen');
      // The void.
      await add('payment_reversals', { school_id: schoolId, payment_id: p, academic_year_id: year, kind: 'void', amount: 1000, reason: 'Bounced', requested_by: principal.userId });
      expect(await one(`SELECT status, payment_id, verified_amount, verified_paid_on, decided_by, decided_at, decision_reason, reopened_at IS NOT NULL AS reopened FROM payment_claims WHERE id = $1`, [id])).toEqual({
        status: 'pending', payment_id: null, verified_amount: null, verified_paid_on: null, decided_by: null, decided_at: null, decision_reason: null, reopened: true,
      });
      expect(await reversing()).not.toBe('on');
      // The voided payment keeps the claim it came from (history, rule 4).
      expect(await one(`SELECT status, claim_id FROM payments WHERE id = $1`, [p])).toEqual({ status: 'voided', claim_id: id.toString() });
      // Back in the queue: verified again with a new payment; reopened_at stays.
      const reopenedAt = (await one(`SELECT reopened_at FROM payment_claims WHERE id = $1`, [id]))?.reopened_at;
      await update(id, verify(await payment(id)));
      expect((await one(`SELECT reopened_at FROM payment_claims WHERE id = $1`, [id]))?.reopened_at).toEqual(reopenedAt);
      // A refund leaves the claim verified.
      const refunded = await add('payment_claims', claimRow());
      const q = await payment(refunded);
      await update(refunded, verify(q));
      await add('payment_reversals', { school_id: schoolId, payment_id: q, academic_year_id: year, kind: 'refund', amount: 100, reason: 'Overpaid', requested_by: principal.userId, approved_by: principal.userId, refund_method: 'cash' });
      expect(await one(`SELECT status FROM payment_claims WHERE id = $1`, [refunded])).toEqual({ status: 'verified' });
    });

    it('rule 4: no claim is ever deleted', async () => {
      await add('payment_claims', claimRow());
      expect(await refusedBy(`DELETE FROM payment_claims WHERE school_id = $1`, [schoolId])).toBe('payment_claims_no_delete');
    });
  });
});
