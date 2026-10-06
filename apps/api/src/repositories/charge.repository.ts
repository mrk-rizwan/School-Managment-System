import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ChargeKind, ChargeStatus, FeeFrequency } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// Charges (tenant table charges, phase-3-financial.md §4, R179-R186). Never deleted; amount,
// student, head, period and due date are frozen by trigger; only the status, the two counters and
// the void and waive stamps move. Finance keys are school-wide (plan rule 0.24): no method takes a
// Scope. Raw SQL only for the row locks (FOR UPDATE in id order, §3.2's lock order); listed in
// RAW_SQL_FILES, each statement filtered on school_id (test/charges/isolation.e2e-spec.ts).

export interface ChargeRecord {
  id: bigint;
  enrolmentId: bigint;
  studentId: bigint;
  academicYearId: bigint;
  feeHeadId: bigint;
  headFrequency: FeeFrequency;
  kind: ChargeKind;
  period: string | null;
  campaignId: bigint | null;
  lateFeeForChargeId: bigint | null;
  adjustsChargeId: bigint | null;
  concessionId: bigint | null;
  grossAmount: number;
  concessionAmount: number;
  amount: number;
  allocatedAmount: number;
  creditedAmount: number;
  description: string;
  dueOn: Date;
  status: ChargeStatus;
  settledAt: Date | null;
  voidedAt: Date | null;
  voidedBy: bigint | null;
  voidReason: string | null;
  waivedAt: Date | null;
  waivedBy: bigint | null;
  waiveReason: string | null;
  createdBy: bigint | null;
  createdAt: Date;
  feeHead: { name: string };
  enrolment: {
    class: { name: string };
    section: { name: string };
    student: { fullName: string; admissionNo: string };
  };
}

const SELECT = {
  id: true,
  enrolmentId: true,
  studentId: true,
  academicYearId: true,
  feeHeadId: true,
  headFrequency: true,
  kind: true,
  period: true,
  campaignId: true,
  lateFeeForChargeId: true,
  adjustsChargeId: true,
  concessionId: true,
  grossAmount: true,
  concessionAmount: true,
  amount: true,
  allocatedAmount: true,
  creditedAmount: true,
  description: true,
  dueOn: true,
  status: true,
  settledAt: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
  waivedAt: true,
  waivedBy: true,
  waiveReason: true,
  createdBy: true,
  createdAt: true,
} satisfies Prisma.ChargeSelect;

type ChargeRow = Omit<ChargeRecord, 'feeHead' | 'enrolment'>;

export type ChargeSort = '-dueOn' | 'dueOn' | 'studentName';

export interface ChargeListQuery {
  studentId?: bigint;
  academicYearId?: bigint;
  classId?: bigint;
  sectionId?: bigint;
  feeHeadId?: bigint;
  period?: string;
  status?: ChargeStatus;
  kind?: ChargeKind;
  dueFrom?: Date;
  dueTo?: Date;
  /** Voided at or after (the principal's "charges voided this week" tile). */
  voidedFrom?: Date;
  sort: ChargeSort;
  skip: number;
  take: number;
}

/** A new charge written by a person (manual, adjustment) or a single-row job write. */
export interface ChargeCreate {
  enrolmentId: bigint;
  studentId: bigint;
  academicYearId: bigint;
  feeHeadId: bigint;
  headFrequency: FeeFrequency;
  kind: ChargeKind;
  period: string | null;
  adjustsChargeId?: bigint | null;
  concessionId: bigint | null;
  grossAmount: number;
  concessionAmount: number;
  description: string;
  dueOn: Date;
  createdBy: bigint | null;
}

/** The statement's sums over one student's year (R205): every line separately, never netted. */
export interface ChargeTotals {
  /** Σ gross of live (not voided, not waived) charges, adjustments excluded. */
  charged: number;
  concession: number;
  /** Σ credits (adjustment rows) on live charges. */
  adjustments: number;
  /** Σ allocated. */
  paid: number;
  /** Σ outstanding of open charges. */
  outstanding: number;
}

@Injectable()
export class ChargeRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async list(schoolId: SchoolId, query: ChargeListQuery): Promise<{ rows: ChargeRecord[]; total: number }> {
    const where: Prisma.ChargeWhereInput = {
      schoolId,
      ...(query.studentId === undefined ? {} : { studentId: query.studentId }),
      ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
      ...(query.feeHeadId === undefined ? {} : { feeHeadId: query.feeHeadId }),
      ...(query.period === undefined ? {} : { period: query.period }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.voidedFrom === undefined ? {} : { voidedAt: { gte: query.voidedFrom } }),
      ...(query.classId === undefined && query.sectionId === undefined
        ? {}
        : {
            enrolment: {
              schoolId,
              ...(query.classId === undefined ? {} : { classId: query.classId }),
              ...(query.sectionId === undefined ? {} : { sectionId: query.sectionId }),
            },
          }),
      ...(query.dueFrom === undefined && query.dueTo === undefined
        ? {}
        : {
            dueOn: {
              ...(query.dueFrom === undefined ? {} : { gte: query.dueFrom }),
              ...(query.dueTo === undefined ? {} : { lte: query.dueTo }),
            },
          }),
    };
    const orderBy: Prisma.ChargeOrderByWithRelationInput[] =
      query.sort === 'studentName'
        ? [{ enrolment: { student: { fullName: 'asc' } } }, { dueOn: 'asc' }, { id: 'asc' }]
        : query.sort === 'dueOn'
          ? [{ dueOn: 'asc' }, { id: 'asc' }]
          : [{ dueOn: 'desc' }, { id: 'desc' }];
    const rows = await this.txHost.tx.charge.findMany({
      where,
      select: SELECT,
      orderBy,
      skip: query.skip,
      take: query.take,
    });
    const total = await this.txHost.tx.charge.count({ where });
    return { rows: await this.named(schoolId, rows), total };
  }

  async findById(schoolId: SchoolId, id: bigint): Promise<ChargeRecord | null> {
    const row = await this.txHost.tx.charge.findFirst({ where: { schoolId, id }, select: SELECT });
    return row ? ((await this.named(schoolId, [row]))[0] ?? null) : null;
  }

  async findByIds(schoolId: SchoolId, ids: readonly bigint[]): Promise<ChargeRecord[]> {
    if (ids.length === 0) return [];
    return this.named(schoolId, await this.txHost.tx.charge.findMany({
      where: { schoolId, id: { in: [...ids] } },
      select: SELECT,
      orderBy: { id: 'asc' },
    }));
  }

  /**
   * Row locks on these charges, taken in id order (§3.2: a payment's charges `ORDER BY id FOR
   * UPDATE`; every path locks charges the same way so two never deadlock). Returns the locked ids.
   */
  async lockForUpdate(schoolId: SchoolId, ids: readonly bigint[]): Promise<bigint[]> {
    if (ids.length === 0) return [];
    const rows = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM charges
       WHERE school_id = ${schoolId} AND id IN (${Prisma.join([...ids])})
       ORDER BY id
         FOR UPDATE`;
    return rows.map((r) => r.id);
  }

  async create(schoolId: SchoolId, data: ChargeCreate, now: Date): Promise<ChargeRecord> {
    const amount = data.grossAmount - data.concessionAmount;
    // An adjustment is a credit: its own settled row (charges_adjustment_row_check); any other
    // row of 0 is settled at birth (R241).
    const settled = data.kind === 'adjustment' || amount === 0;
    const [created] = await this.named(schoolId, [await this.txHost.tx.charge.create({
      data: {
        schoolId,
        enrolmentId: data.enrolmentId,
        studentId: data.studentId,
        academicYearId: data.academicYearId,
        feeHeadId: data.feeHeadId,
        headFrequency: data.headFrequency,
        kind: data.kind,
        period: data.period,
        adjustsChargeId: data.adjustsChargeId ?? null,
        concessionId: data.concessionId,
        grossAmount: data.grossAmount,
        concessionAmount: data.concessionAmount,
        amount,
        description: data.description,
        dueOn: data.dueOn,
        status: settled ? 'settled' : 'open',
        settledAt: settled ? now : null,
        createdBy: data.createdBy,
      },
      select: SELECT,
    })]);
    if (!created) throw new Error('charge not written');
    return created;
  }

  /** open → voided with no allocation and no credit; 0 when the row moved (the caller holds its lock). */
  async void(schoolId: SchoolId, id: bigint, by: bigint, reason: string, now: Date): Promise<number> {
    const { count } = await this.txHost.tx.charge.updateMany({
      where: { schoolId, id, status: 'open', allocatedAmount: 0, creditedAmount: 0 },
      data: { status: 'voided', voidedAt: now, voidedBy: by, voidReason: reason },
    });
    return count;
  }

  /** open late fee → waived with no live allocation; 0 when the row moved. */
  async waive(schoolId: SchoolId, id: bigint, by: bigint, reason: string, now: Date): Promise<number> {
    const { count } = await this.txHost.tx.charge.updateMany({
      where: { schoolId, id, kind: 'late_fee', status: 'open', allocatedAmount: 0 },
      data: { status: 'waived', waivedAt: now, waivedBy: by, waiveReason: reason },
    });
    return count;
  }

  /** The open late fees charged against `chargeId` (at most one live, charges_late_fee_key). */
  async openLateFeesFor(schoolId: SchoolId, chargeId: bigint): Promise<ChargeRecord[]> {
    return this.named(schoolId, await this.txHost.tx.charge.findMany({
      where: { schoolId, lateFeeForChargeId: chargeId, kind: 'late_fee', status: 'open' },
      select: SELECT,
      orderBy: { id: 'asc' },
    }));
  }

  /**
   * A6: the open, unconceded charges of a student's year on the named heads from `fromPeriod`
   * (a charge without a period counts by its due month): what "apply to N open charges" credits.
   * Late fees and adjustments are never conceded.
   */
  async openForConcession(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
    feeHeadIds: readonly bigint[],
    fromPeriod: string,
  ): Promise<ChargeRecord[]> {
    const fromDay = new Date(`${fromPeriod}-01T00:00:00.000Z`);
    return this.named(schoolId, await this.txHost.tx.charge.findMany({
      where: {
        schoolId,
        studentId,
        academicYearId,
        feeHeadId: { in: [...feeHeadIds] },
        status: 'open',
        concessionId: null,
        kind: { in: ['generated', 'manual', 'campaign'] },
        OR: [{ period: { gte: fromPeriod } }, { period: null, dueOn: { gte: fromDay } }],
      },
      select: SELECT,
      orderBy: { id: 'asc' },
    }));
  }

  /**
   * Slice 20: the open charges of these children (of one year, when given), oldest due first:
   * what a payment allocates over (R188) and the counter shows. Read after the caller has locked
   * them when it writes. `take` bounds a list the counter shows.
   */
  async openOfStudents(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    academicYearId?: bigint,
    take?: number,
  ): Promise<ChargeRecord[]> {
    if (studentIds.length === 0) return [];
    return this.named(schoolId, await this.txHost.tx.charge.findMany({
      where: {
        schoolId,
        studentId: { in: [...new Set(studentIds)] },
        ...(academicYearId === undefined ? {} : { academicYearId }),
        status: 'open',
      },
      select: SELECT,
      orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      ...(take === undefined ? {} : { take }),
    }));
  }

  /** The ids of these children's open charges in one year (to lock them in id order, R236). */
  async openIdsOfStudents(schoolId: SchoolId, studentIds: readonly bigint[], academicYearId: bigint): Promise<bigint[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.charge.findMany({
      where: { schoolId, studentId: { in: [...new Set(studentIds)] }, academicYearId, status: 'open' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** The `once`-head charges admission or readmission wrote on this enrolment (R239). */
  async onceChargesOf(schoolId: SchoolId, enrolmentId: bigint): Promise<ChargeRecord[]> {
    return this.named(schoolId, await this.txHost.tx.charge.findMany({
      where: { schoolId, enrolmentId, kind: 'generated', headFrequency: 'once' },
      select: SELECT,
      orderBy: { id: 'asc' },
    }));
  }

  /** One page of a student's year, oldest due first (the statement). */
  async forStatement(
    schoolId: SchoolId,
    studentId: bigint,
    academicYearId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: ChargeRecord[]; total: number }> {
    const where: Prisma.ChargeWhereInput = { schoolId, studentId, academicYearId, kind: { not: 'adjustment' } };
    const rows = await this.txHost.tx.charge.findMany({
      where,
      select: SELECT,
      orderBy: [{ dueOn: 'asc' }, { id: 'asc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.charge.count({ where });
    return { rows: await this.named(schoolId, rows), total };
  }

  /** Every adjustment row of a student's year (bounded: one per credit decision). */
  async adjustmentsOf(schoolId: SchoolId, studentId: bigint, academicYearId: bigint): Promise<ChargeRecord[]> {
    return this.named(schoolId, await this.txHost.tx.charge.findMany({
      where: { schoolId, studentId, academicYearId, kind: 'adjustment' },
      select: SELECT,
      orderBy: { id: 'asc' },
    }));
  }

  /**
   * The display names of each row (head, class, section, student), read in separate sequential
   * statements: Prisma loads sibling relations of one select concurrently, and statements must
   * not overlap inside a transaction.
   */
  private async named(schoolId: SchoolId, rows: readonly ChargeRow[]): Promise<ChargeRecord[]> {
    if (rows.length === 0) return [];
    const uniq = (ids: bigint[]) => [...new Set(ids)];
    const heads = await this.txHost.tx.feeHead.findMany({
      where: { schoolId, id: { in: uniq(rows.map((r) => r.feeHeadId)) } },
      select: { id: true, name: true },
    });
    const enrolments = await this.txHost.tx.enrolment.findMany({
      where: { schoolId, id: { in: uniq(rows.map((r) => r.enrolmentId)) } },
      select: { id: true, classId: true, sectionId: true },
    });
    const classes = await this.txHost.tx.class.findMany({
      where: { schoolId, id: { in: uniq(enrolments.map((e) => e.classId)) } },
      select: { id: true, name: true },
    });
    const sections = await this.txHost.tx.section.findMany({
      where: { schoolId, id: { in: uniq(enrolments.map((e) => e.sectionId)) } },
      select: { id: true, name: true },
    });
    const students = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: uniq(rows.map((r) => r.studentId)) } },
      select: { id: true, fullName: true, admissionNo: true },
    });
    const head = new Map(heads.map((h) => [h.id, h.name]));
    const enrolment = new Map(enrolments.map((e) => [e.id, e]));
    const klass = new Map(classes.map((c) => [c.id, c.name]));
    const section = new Map(sections.map((c) => [c.id, c.name]));
    const student = new Map(students.map((c) => [c.id, c]));
    return rows.map((row) => {
      const e = enrolment.get(row.enrolmentId);
      const st = student.get(row.studentId);
      return {
        ...row,
        feeHead: { name: head.get(row.feeHeadId) ?? '' },
        enrolment: {
          class: { name: (e && klass.get(e.classId)) ?? '' },
          section: { name: (e && section.get(e.sectionId)) ?? '' },
          student: { fullName: st?.fullName ?? '', admissionNo: st?.admissionNo ?? '' },
        },
      };
    });
  }

  async totals(schoolId: SchoolId, studentId: bigint, academicYearId: bigint): Promise<ChargeTotals> {
    const live = await this.txHost.tx.charge.aggregate({
      where: {
        schoolId,
        studentId,
        academicYearId,
        kind: { not: 'adjustment' },
        status: { in: ['open', 'settled'] },
      },
      _sum: { grossAmount: true, concessionAmount: true, allocatedAmount: true, creditedAmount: true },
    });
    const open = await this.txHost.tx.charge.aggregate({
      where: { schoolId, studentId, academicYearId, status: 'open' },
      _sum: { amount: true, allocatedAmount: true, creditedAmount: true },
    });
    return {
      charged: live._sum.grossAmount ?? 0,
      concession: live._sum.concessionAmount ?? 0,
      adjustments: live._sum.creditedAmount ?? 0,
      paid: live._sum.allocatedAmount ?? 0,
      outstanding:
        (open._sum.amount ?? 0) - (open._sum.allocatedAmount ?? 0) - (open._sum.creditedAmount ?? 0),
    };
  }

  /** An enrolment a manual charge names, with what decides it (R186, R242). */
  async enrolmentForCharge(
    schoolId: SchoolId,
    enrolmentId: bigint,
  ): Promise<{
    id: bigint;
    studentId: bigint;
    academicYearId: bigint;
    endedOn: Date | null;
    student: { status: string };
    academicYear: { status: string };
  } | null> {
    const row = await this.txHost.tx.enrolment.findFirst({
      where: { schoolId, id: enrolmentId },
      select: {
        id: true,
        studentId: true,
        academicYearId: true,
        endedOn: true,
        student: { select: { status: true } },
      },
    });
    if (!row) return null;
    const year = await this.txHost.tx.academicYear.findFirst({
      where: { schoolId, id: row.academicYearId },
      select: { status: true },
    });
    return year ? { ...row, academicYear: year } : null;
  }

  /** The student's latest enrolment's year (a statement's default), or null with no enrolment. */
  async latestYearOf(schoolId: SchoolId, studentId: bigint): Promise<bigint | null> {
    const row = await this.txHost.tx.enrolment.findFirst({
      where: { schoolId, studentId },
      select: { academicYearId: true },
      orderBy: [{ startedOn: 'desc' }, { id: 'desc' }],
    });
    return row?.academicYearId ?? null;
  }

  async studentExists(schoolId: SchoolId, studentId: bigint): Promise<boolean> {
    return (await this.txHost.tx.student.count({ where: { schoolId, id: studentId } })) === 1;
  }

  /** Charges voided since `since` (the principal's "charges voided this week" tile). */
  countVoidedSince(schoolId: SchoolId, since: Date): Promise<number> {
    return this.txHost.tx.charge.count({ where: { schoolId, status: 'voided', voidedAt: { gte: since } } });
  }
}
