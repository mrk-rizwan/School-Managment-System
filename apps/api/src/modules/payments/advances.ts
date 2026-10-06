import { Injectable } from '@nestjs/common';
import { allocate, outstanding } from '@asms/shared';
import { concurrentUpdate } from '../../common/errors/api-exception';
import { ChargeRepository, type ChargeRecord } from '../../repositories/charge.repository';
import { FeeHeadRepository } from '../../repositories/fee-head.repository';
import { PaymentAllocationRepository, type NewAllocation } from '../../repositories/payment-allocation.repository';
import { PaymentRepository } from '../../repositories/payment.repository';
import type { SchoolId } from '../../tenancy/school-id';

/** What an advance application wrote: the allocations and their sum. */
export interface AppliedAdvance {
  allocations: NewAllocation[];
  amount: number;
}

const NONE: AppliedAdvance = { allocations: [], amount: 0 };

/**
 * The two places a payment's remainder moves outside the counter (phase-3-financial.md §1.1
 * "Advances", A5, A6, R186, R189), shared by the fee side (slice 19's insert paths and credits)
 * and the payment side. Each runs inside its caller's transaction and keeps R236's lock order:
 * the payments first, by id, then the charges, by id.
 */
@Injectable()
export class Advances {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly allocations: PaymentAllocationRepository,
    private readonly charges: ChargeRepository,
    private readonly heads: FeeHeadRepository,
  ) {}

  /**
   * R189, A5: the children's advances in `academicYearId` pay their open charges of that year,
   * oldest due first (allocate() with no new money), fines and late fees included. Called after a
   * new open charge appears for a child (generation, campaign, manual charge, late fee, carry-
   * forward). Nothing to do, and nothing locked beyond one index read, when no child has one.
   */
  async applyTo(schoolId: SchoolId, academicYearId: bigint, studentIds: readonly bigint[]): Promise<AppliedAdvance> {
    if (studentIds.length === 0) return NONE;
    const advances = await this.payments.lockAdvances(schoolId, studentIds, academicYearId);
    if (advances.length === 0) return NONE;
    const children = [...new Set(advances.map((a) => a.studentId))];
    await this.charges.lockForUpdate(schoolId, await this.charges.openIdsOfStudents(schoolId, children, academicYearId));
    const open = await this.charges.openOfStudents(schoolId, children, academicYearId);
    const result = allocate(0, children, open.map(openCharge), advances);
    const rows = result.allocations.flatMap((a): NewAllocation[] =>
      a.paymentId === null
        ? []
        : [{ paymentId: a.paymentId, chargeId: a.chargeId, studentId: a.studentId, academicYearId, amount: a.amount }],
    );
    const written = await this.insertMerged(schoolId, rows, new Date());
    return { allocations: written, amount: written.reduce((sum, r) => sum + r.amount, 0) };
  }

  /**
   * Writes new allocations under the caller's locks, one statement each way. A payment has at most
   * one live allocation per charge (payment_allocations_live_key): where an advance tops up a
   * charge its payment already pays part of (after a void or a credit reopened it), the live row is
   * reversed and written again with the sum. An admission-head row is never reversed outside a void
   * (payment_allocations_admission_reversal), so such a top-up is left as advance. Returns the
   * allocations that moved money (their amounts are the new money only).
   */
  async insertMerged(schoolId: SchoolId, rows: readonly NewAllocation[], now: Date): Promise<NewAllocation[]> {
    if (rows.length === 0) return [];
    const existing = await this.allocations.liveOfCharges(schoolId, rows.map((r) => r.chargeId));
    const pair = (paymentId: bigint, chargeId: bigint) => `${paymentId}:${chargeId}`;
    const live = new Map(existing.map((a) => [pair(a.paymentId, a.chargeId), a]));
    const charges = new Map((await this.charges.findByIds(schoolId, rows.map((r) => r.chargeId))).map((c) => [c.id, c]));
    const admission = new Set<bigint>();
    for (const headId of new Set([...charges.values()].map((c) => c.feeHeadId))) {
      if ((await this.heads.findById(schoolId, headId))?.category === 'admission') admission.add(headId);
    }
    const reversed: bigint[] = [];
    const insert: NewAllocation[] = [];
    const moved: NewAllocation[] = [];
    for (const row of rows) {
      const prior = live.get(pair(row.paymentId, row.chargeId));
      if (!prior) {
        insert.push(row);
        moved.push(row);
        continue;
      }
      const head = charges.get(row.chargeId)?.feeHeadId;
      if (head !== undefined && admission.has(head)) continue;
      reversed.push(prior.id);
      insert.push({ ...row, amount: row.amount + prior.amount });
      moved.push(row);
    }
    if ((await this.allocations.reverse(schoolId, reversed, now)) !== reversed.length) throw concurrentUpdate();
    await this.allocations.insert(schoolId, insert);
    return moved;
  }

  /**
   * R236 for a correction that moves money and then re-applies the children's advances (a void, a
   * credit): every lock it will need, taken up front in the one order — the named payments and the
   * children's live advances in the year by id, then the named charges and the children's open
   * charges in the year by id — so the later applyTo() takes no lock out of order.
   */
  async lockFamily(
    schoolId: SchoolId,
    academicYearId: bigint,
    studentIds: readonly bigint[],
    paymentIds: readonly bigint[],
    chargeIds: readonly bigint[],
  ): Promise<Set<bigint>> {
    const advances = await this.payments.advances(schoolId, studentIds, academicYearId);
    const locked = new Set(
      await this.payments.lockForUpdate(schoolId, [...paymentIds, ...advances.map((a) => a.paymentId)]),
    );
    const open = await this.charges.openIdsOfStudents(schoolId, studentIds, academicYearId);
    await this.charges.lockForUpdate(schoolId, [...new Set([...chargeIds, ...open])]);
    return locked;
  }

  /**
   * A6, R186, R236: the locks a credit needs (lockFamily over the charges' payments, the child's
   * advances and open charges), and the charges re-read under them. A payment that allocated to
   * one of them between the two reads would be locked out of order, so it fails the request as
   * CONCURRENT_UPDATE (retried once by the caller). The charges are one child's of one year.
   */
  async lockForCredit(schoolId: SchoolId, chargeIds: readonly bigint[]): Promise<ChargeRecord[]> {
    if (chargeIds.length === 0) return [];
    const pre = await this.charges.findByIds(schoolId, chargeIds);
    const first = pre[0];
    if (!first) return [];
    const before = await this.allocations.liveOfCharges(schoolId, chargeIds);
    const locked = await this.lockFamily(
      schoolId,
      first.academicYearId,
      [...new Set(pre.map((c) => c.studentId))],
      before.map((a) => a.paymentId),
      chargeIds,
    );
    const after = await this.allocations.liveOfCharges(schoolId, chargeIds);
    if (after.some((a) => !locked.has(a.paymentId))) throw concurrentUpdate();
    return this.charges.findByIds(schoolId, chargeIds);
  }

  /**
   * A6, R186: frees up to `need` of a locked charge's money by de-allocating its newest live
   * allocations back into their payments as advances for the same child (a partly kept allocation
   * is reversed and written again for the part that stays). Never an admission-head allocation
   * (payment_allocations_admission_reversal), never into a payment whose advance belongs to
   * another child. Returns what it freed (≤ need): the caller refuses or caps the credit.
   * Σcredit = Δoutstanding + Δunallocated holds by construction.
   */
  async deallocate(schoolId: SchoolId, charge: ChargeRecord, need: number, now: Date): Promise<number> {
    if (need <= 0) return 0;
    const head = await this.heads.findById(schoolId, charge.feeHeadId);
    if (!head || head.category === 'admission') return 0;
    const live = await this.allocations.liveOfCharges(schoolId, [charge.id]);
    const owners = new Map((await this.payments.findByIds(schoolId, live.map((a) => a.paymentId))).map((p) => [p.id, p]));
    let left = need;
    const reversed: bigint[] = [];
    const kept: NewAllocation[] = [];
    const bound = new Set<bigint>();
    for (const a of live) {
      if (left === 0) break;
      const payment = owners.get(a.paymentId);
      if (!payment || payment.status !== 'verified') continue;
      if (payment.advanceForStudentId !== null && payment.advanceForStudentId !== charge.studentId) continue;
      const take = Math.min(a.amount, left);
      left -= take;
      reversed.push(a.id);
      bound.add(a.paymentId);
      if (take < a.amount) {
        kept.push({
          paymentId: a.paymentId,
          chargeId: a.chargeId,
          studentId: a.studentId,
          academicYearId: a.academicYearId,
          amount: a.amount - take,
        });
      }
    }
    if (reversed.length === 0) return 0;
    if ((await this.allocations.reverse(schoolId, reversed, now)) !== reversed.length) throw concurrentUpdate();
    await this.allocations.insert(schoolId, kept);
    for (const paymentId of bound) await this.payments.bindAdvance(schoolId, paymentId, charge.studentId);
    return need - left;
  }
}

/** A charge as allocate() reads it. */
export const openCharge = (c: ChargeRecord) => ({
  id: c.id,
  studentId: c.studentId,
  dueOn: c.dueOn.toISOString().slice(0, 10),
  outstanding: outstanding(c),
});
