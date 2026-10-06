import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { PaymentMethod, PaymentStatus } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// Payments (tenant table payments, phase-3-financial.md §3.2, §3.4, §4 "Payments", R187-R195).
// Never deleted; amount, payer, method, dates and the recorder are frozen by trigger; only the
// status, unallocated_amount (trigger-maintained), voided_at, handover_id and
// advance_for_student_id (each once) move. Finance keys are school-wide (rule 0.24): no method
// takes a Scope. Raw SQL only for the row locks (FOR UPDATE in id order, §3.2's lock order R236);
// listed in RAW_SQL_FILES, each statement filtered on school_id (test/payments/isolation.e2e-spec.ts).

export interface PaymentRecord {
  id: bigint;
  academicYearId: bigint;
  payerGuardianId: bigint | null;
  payerName: string | null;
  method: PaymentMethod;
  amount: number;
  unallocatedAmount: number;
  receivedOn: Date;
  reference: string | null;
  carriedFromReversalId: bigint | null;
  recordedBy: bigint;
  recordedAt: Date;
  verifiedBy: bigint;
  verifiedAt: Date;
  handoverId: bigint | null;
  advanceForStudentId: bigint | null;
  /** The deposit claim whose verification recorded it (slice 21); kept after a void. */
  claimId: bigint | null;
  status: PaymentStatus;
  voidedAt: Date | null;
}

const SELECT = {
  id: true,
  academicYearId: true,
  payerGuardianId: true,
  payerName: true,
  method: true,
  amount: true,
  unallocatedAmount: true,
  receivedOn: true,
  reference: true,
  carriedFromReversalId: true,
  recordedBy: true,
  recordedAt: true,
  verifiedBy: true,
  verifiedAt: true,
  handoverId: true,
  advanceForStudentId: true,
  claimId: true,
  status: true,
  voidedAt: true,
} satisfies Prisma.PaymentSelect;

export interface NewPayment {
  academicYearId: bigint;
  payerGuardianId: bigint | null;
  payerName: string | null;
  method: PaymentMethod;
  amount: number;
  receivedOn: Date;
  reference: string | null;
  carriedFromReversalId: bigint | null;
  /** The office path: the recorder verifies at recording (rule 25, R187). */
  recordedBy: bigint;
  advanceForStudentId: bigint | null;
  /** Slice 21: the claim a verification records this payment for; set at insert, never changed. */
  claimId?: bigint | null;
}

export interface PaymentListQuery {
  receivedFrom?: Date;
  receivedTo?: Date;
  method?: PaymentMethod;
  status?: PaymentStatus;
  recordedBy?: bigint;
  /** Paid towards this child (a live or reversed allocation) or holding their advance. */
  studentId?: bigint;
  academicYearId?: bigint;
  handoverId?: bigint;
  skip: number;
  take: number;
}

/** An unallocated remainder bound to a child (R189), as allocate() reads it. */
export interface AdvanceRow {
  paymentId: bigint;
  studentId: bigint;
  unallocated: number;
}

@Injectable()
export class PaymentRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async create(schoolId: SchoolId, data: NewPayment, now: Date): Promise<PaymentRecord> {
    return this.txHost.tx.payment.create({
      data: {
        schoolId,
        ...data,
        // The trigger sets unallocated_amount to the amount (payments_unallocated_init).
        unallocatedAmount: data.amount,
        recordedAt: now,
        verifiedBy: data.recordedBy,
        verifiedAt: now,
      },
      select: SELECT,
    });
  }

  findById(schoolId: SchoolId, id: bigint): Promise<PaymentRecord | null> {
    return this.txHost.tx.payment.findFirst({ where: { schoolId, id }, select: SELECT });
  }

  async findByIds(schoolId: SchoolId, ids: readonly bigint[]): Promise<PaymentRecord[]> {
    if (ids.length === 0) return [];
    return this.txHost.tx.payment.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: SELECT,
      orderBy: { id: 'asc' },
    });
  }

  async list(schoolId: SchoolId, query: PaymentListQuery): Promise<{ rows: PaymentRecord[]; total: number }> {
    const where: Prisma.PaymentWhereInput = {
      schoolId,
      ...(query.method === undefined ? {} : { method: query.method }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.recordedBy === undefined ? {} : { recordedBy: query.recordedBy }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.handoverId === undefined ? {} : { handoverId: query.handoverId }),
      ...(query.studentId === undefined
        ? {}
        : {
            OR: [
              { advanceForStudentId: query.studentId },
              { allocations: { some: { schoolId, studentId: query.studentId } } },
            ],
          }),
      ...(query.receivedFrom === undefined && query.receivedTo === undefined
        ? {}
        : {
            receivedOn: {
              ...(query.receivedFrom === undefined ? {} : { gte: query.receivedFrom }),
              ...(query.receivedTo === undefined ? {} : { lte: query.receivedTo }),
            },
          }),
    };
    const rows = await this.txHost.tx.payment.findMany({
      where,
      select: SELECT,
      orderBy: [{ receivedOn: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.payment.count({ where });
    return { rows, total };
  }

  /**
   * Row locks on these payments, in id order (§3.2: the payment rows first, then their charges;
   * every path locks payments the same way so two never deadlock). Returns the locked ids.
   */
  async lockForUpdate(schoolId: SchoolId, ids: readonly bigint[]): Promise<bigint[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM payments
       WHERE school_id = ${schoolId} AND id IN (${Prisma.join([...new Set(ids)])})
       ORDER BY id
         FOR UPDATE`;
    return rows.map((r) => r.id);
  }

  /**
   * R189: locks the live advances of these children in one year (verified payments with an
   * unallocated remainder bound to one of them), in id order, and returns them as they stand
   * under the lock. The first lock of every path that spends an advance (R236).
   */
  async lockAdvances(schoolId: SchoolId, studentIds: readonly bigint[], academicYearId: bigint): Promise<AdvanceRow[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint; advance_for_student_id: bigint; unallocated_amount: number }[]>`
      SELECT id, advance_for_student_id, unallocated_amount FROM payments
       WHERE school_id = ${schoolId}
         AND academic_year_id = ${academicYearId}
         AND advance_for_student_id IN (${Prisma.join([...new Set(studentIds)])})
         AND status = 'verified'
         AND unallocated_amount > 0
       ORDER BY id
         FOR UPDATE`;
    return rows.map((r) => ({ paymentId: r.id, studentId: r.advance_for_student_id, unallocated: r.unallocated_amount }));
  }

  /** The same advances, unlocked (the preview, the dues screen, the statement). */
  async advances(schoolId: SchoolId, studentIds: readonly bigint[], academicYearId?: bigint): Promise<(AdvanceRow & { academicYearId: bigint })[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.payment.findMany({
      where: {
        schoolId,
        ...(academicYearId === undefined ? {} : { academicYearId }),
        advanceForStudentId: { in: [...new Set(studentIds)] },
        status: 'verified',
        unallocatedAmount: { gt: 0 },
      },
      select: { id: true, advanceForStudentId: true, unallocatedAmount: true, academicYearId: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({
      paymentId: r.id,
      studentId: r.advanceForStudentId ?? 0n,
      unallocated: r.unallocatedAmount,
      academicYearId: r.academicYearId,
    }));
  }

  /** Binds a payment's remainder to a child, once (R189; payments_advance_for_student_id_frozen). */
  async bindAdvance(schoolId: SchoolId, id: bigint, studentId: bigint): Promise<number> {
    const { count } = await this.txHost.tx.payment.updateMany({
      where: { schoolId, id, advanceForStudentId: null },
      data: { advanceForStudentId: studentId },
    });
    return count;
  }

  /**
   * R249: an earlier live payment with the same method, reference and day (a slip recorded twice).
   * A warning, never a refusal.
   */
  async sameSlip(
    schoolId: SchoolId,
    slip: { method: PaymentMethod; reference: string; receivedOn: Date; excludeId: bigint },
  ): Promise<bigint | null> {
    const row = await this.txHost.tx.payment.findFirst({
      where: {
        schoolId,
        method: slip.method,
        reference: slip.reference,
        receivedOn: slip.receivedOn,
        status: 'verified',
        id: { not: slip.excludeId },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return row?.id ?? null;
  }

  // ------------------------------------------------------------------------- custody (§3.4)

  /** A collector's cash in hand: live cash payments they recorded that no handover gathered. */
  async custody(schoolId: SchoolId, userId: bigint): Promise<{ cashInHand: number; paymentCount: number; since: Date | null }> {
    const row = await this.txHost.tx.payment.aggregate({
      where: { schoolId, recordedBy: userId, method: 'cash', status: 'verified', handoverId: null },
      _sum: { amount: true },
      _count: { _all: true },
      _min: { recordedAt: true },
    });
    return { cashInHand: row._sum.amount ?? 0, paymentCount: row._count._all, since: row._min.recordedAt };
  }

  /**
   * §3.4: locks the collector's custody payments by id (the handover's first lock) and returns
   * them as they stand under it.
   */
  async lockCustody(schoolId: SchoolId, userId: bigint): Promise<{ id: bigint; amount: number }[]> {
    return this.txHost.tx.$queryRaw<{ id: bigint; amount: number }[]>`
      SELECT id, amount FROM payments
       WHERE school_id = ${schoolId}
         AND recorded_by = ${userId}
         AND method = 'cash'
         AND status = 'verified'
         AND handover_id IS NULL
       ORDER BY id
         FOR UPDATE`;
  }

  // ------------------------------------------------------------------- reads for the counter

  /**
   * Slice 21 (R199): a row lock on the guardian, so their claims of one day are counted and
   * written one at a time (the daily cap holds under concurrency). False when absent.
   */
  async lockGuardian(schoolId: SchoolId, guardianId: bigint): Promise<boolean> {
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM guardians WHERE school_id = ${schoolId} AND id = ${guardianId} FOR UPDATE`;
    return rows.length === 1;
  }

  /** A guardian as the counter needs it; null when absent from this school. */
  findGuardian(schoolId: SchoolId, id: bigint): Promise<{ id: bigint; fullName: string; mergedIntoId: bigint | null } | null> {
    return this.txHost.tx.guardian.findFirst({
      where: { schoolId, id },
      select: { id: true, fullName: true, mergedIntoId: true },
    });
  }

  /** The children a guardian has a live link to (a family is bounded: the counter shows ≤ 10). */
  async liveChildren(schoolId: SchoolId, guardianId: bigint, take: number): Promise<{ studentId: bigint; fullName: string }[]> {
    const links = await this.txHost.tx.studentGuardian.findMany({
      where: { schoolId, guardianId, endedAt: null },
      select: { studentId: true },
      orderBy: { studentId: 'asc' },
      take,
    });
    const students = await this.students(schoolId, links.map((l) => l.studentId));
    return links.map((l) => ({ studentId: l.studentId, fullName: students.get(l.studentId)?.fullName ?? '' }));
  }

  /** Which of `studentIds` the guardian has a live link to (R187). */
  async linkedTo(schoolId: SchoolId, guardianId: bigint, studentIds: readonly bigint[]): Promise<Set<bigint>> {
    if (studentIds.length === 0) return new Set();
    const rows = await this.txHost.tx.studentGuardian.findMany({
      where: { schoolId, guardianId, endedAt: null, studentId: { in: [...new Set(studentIds)] } },
      select: { studentId: true },
    });
    return new Set(rows.map((r) => r.studentId));
  }

  /** Students by id, with their names. */
  async students(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, { fullName: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, { fullName: r.fullName }]));
  }

  /**
   * R232: the user's own guardian record, merge-resolved (asms_user_is_guardian over
   * asms_guardian_merge_family), is `guardianId`: a payment whose payer is the actor is their
   * own money. The same predicate as the payment triggers.
   */
  async userIsGuardian(schoolId: SchoolId, userId: bigint, guardianId: bigint): Promise<boolean> {
    const rows = await this.txHost.tx.$queryRaw<{ own: boolean }[]>`
      SELECT asms_user_is_guardian(${schoolId}::bigint, ${userId}::bigint, ${guardianId}::bigint) AS own`;
    return rows[0]?.own === true;
  }

  /**
   * Each student's latest enrolment in each year they are enrolled in, with its class, newest
   * year first (the counter groups a family's dues by year).
   */
  async enrolmentsOf(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    academicYearId?: bigint,
  ): Promise<{ id: bigint; studentId: bigint; academicYearId: bigint; className: string; yearName: string; startsOn: Date }[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.enrolment.findMany({
      where: {
        schoolId,
        studentId: { in: [...new Set(studentIds)] },
        ...(academicYearId === undefined ? {} : { academicYearId }),
      },
      select: { id: true, studentId: true, academicYearId: true, classId: true },
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.studentId}:${row.academicYearId}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    const kept = [...latest.values()];
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: [...new Set(kept.map((r) => r.classId))] } },
      select: { id: true, name: true },
    });
    const years = await this.yearsByIds(schoolId, kept.map((r) => r.academicYearId));
    const className = new Map(classes.map((c) => [c.id, c.name]));
    return kept
      .map((r) => {
        const year = years.get(r.academicYearId);
        return {
          id: r.id,
          studentId: r.studentId,
          academicYearId: r.academicYearId,
          className: className.get(r.classId) ?? '',
          yearName: year?.name ?? '',
          startsOn: year?.startsOn ?? new Date(0),
        };
      })
      .sort((a, b) => b.startsOn.getTime() - a.startsOn.getTime() || (a.studentId < b.studentId ? -1 : 1));
  }

  /** Academic years by id: name, status and dates. */
  async yearsByIds(
    schoolId: SchoolId,
    ids: readonly bigint[],
  ): Promise<Map<bigint, { name: string; status: string; startsOn: Date }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.academicYear.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, name: true, status: true, startsOn: true },
    });
    return new Map(rows.map((r) => [r.id, { name: r.name, status: r.status, startsOn: r.startsOn }]));
  }

  /** Users' display names: the staff record's name, else the guardian's. */
  async userNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.txHost.tx.user.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, staffId: true, guardianId: true },
    });
    const staff = await this.txHost.tx.staff.findMany({
      where: { schoolId, id: { in: users.flatMap((u) => (u.staffId === null ? [] : [u.staffId])) } },
      select: { id: true, fullName: true },
    });
    const guardians = await this.guardianNames(schoolId, users.flatMap((u) => (u.guardianId === null ? [] : [u.guardianId])));
    const staffName = new Map(staff.map((s) => [s.id, s.fullName]));
    return new Map(
      users.map((u) => [
        u.id,
        (u.staffId === null ? undefined : staffName.get(u.staffId)) ??
          (u.guardianId === null ? undefined : guardians.get(u.guardianId)) ??
          '',
      ]),
    );
  }

  async guardianNames(schoolId: SchoolId, ids: readonly bigint[]): Promise<Map<bigint, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.txHost.tx.guardian.findMany({
      where: { schoolId, id: { in: [...new Set(ids)] } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }

  /**
   * The receipt_issued audience (§1.1 "Receipt channel"): the children's live fee-payer guardians,
   * else their primary contacts, else every live guardian; unmerged only (senders resolve
   * survivors).
   */
  async receiptRecipients(schoolId: SchoolId, studentIds: readonly bigint[]): Promise<bigint[]> {
    if (studentIds.length === 0) return [];
    const links = await this.txHost.tx.studentGuardian.findMany({
      where: {
        schoolId,
        studentId: { in: [...new Set(studentIds)] },
        endedAt: null,
        guardian: { schoolId, mergedIntoId: null },
      },
      select: { guardianId: true, isFeePayer: true, isPrimaryContact: true },
      orderBy: { guardianId: 'asc' },
    });
    const pick = (keep: (l: (typeof links)[number]) => boolean) => [...new Set(links.filter(keep).map((l) => l.guardianId))];
    const payers = pick((l) => l.isFeePayer);
    if (payers.length > 0) return payers;
    const primary = pick((l) => l.isPrimaryContact);
    return primary.length > 0 ? primary : pick(() => true);
  }

  /** A user's staff record and its status (an on-behalf handover's collector). */
  async staffOfUser(schoolId: SchoolId, userId: bigint): Promise<{ staffId: bigint; status: string } | null> {
    const user = await this.txHost.tx.user.findFirst({ where: { schoolId, id: userId }, select: { staffId: true } });
    if (!user || user.staffId === null) return null;
    const staff = await this.txHost.tx.staff.findFirst({ where: { schoolId, id: user.staffId }, select: { status: true } });
    return staff ? { staffId: user.staffId, status: staff.status } : null;
  }

  /** Gathers locked custody payments into an open handover (once; payments_handover_open). */
  async joinHandover(schoolId: SchoolId, ids: readonly bigint[], handoverId: bigint): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await this.txHost.tx.payment.updateMany({
      where: { schoolId, id: { in: [...ids] }, handoverId: null, status: 'verified' },
      data: { handoverId },
    });
    return count;
  }
}
