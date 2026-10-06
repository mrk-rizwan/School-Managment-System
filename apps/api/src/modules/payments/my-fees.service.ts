import { Injectable } from '@nestjs/common';
import { outstanding } from '@asms/shared';
import { scopeOf, type SchoolSessionContext } from '../../common/auth/school-session';
import { notFound } from '../../common/errors/api-exception';
import { toPage, type Page } from '../../common/pagination';
import { SchoolClock } from '../../common/school-clock';
import { SchoolContext } from '../../common/school-context';
import { ChargeRepository, type ChargeRecord } from '../../repositories/charge.repository';
import { PaymentAccountRepository } from '../../repositories/payment-account.repository';
import { PaymentRepository } from '../../repositories/payment.repository';
import { ReceiptRepository, type ReceiptRecord } from '../../repositories/receipt.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { toDateString } from '../academics/academics.shared';
import type { MyChargeDto, MyDuesDto, MyDuesQueryDto, MyReceiptDto, MyReceiptsQueryDto } from './claims.dto';
import { receiptLabel } from './payments.shared';

/** MyDuesDto lists at most this many open charges (the plan's bound). */
const DUES_CHARGES = 50;

/** The guardian's live login children (the capacity scope, R163, R198); [] for any other scope. */
export function myChildren(session: SchoolSessionContext): bigint[] {
  const scope = scopeOf(session);
  return scope.kind === 'students' ? [...scope.ids] : [];
}

/** 404 unless the child is one of the guardian's live login children (R198: the same as absent). */
export function requireMyChild(session: SchoolSessionContext, studentId: bigint): void {
  if (!myChildren(session).includes(studentId)) throw notFound();
}

export function toMyChargeDto(row: ChargeRecord): MyChargeDto {
  return {
    id: row.id.toString(),
    academicYearId: row.academicYearId.toString(),
    feeHeadName: row.feeHead.name,
    kind: row.kind,
    period: row.period,
    description: row.description,
    dueOn: toDateString(row.dueOn),
    grossAmount: row.grossAmount,
    concessionAmount: row.concessionAmount,
    amount: row.amount,
    paidAmount: row.allocatedAmount,
    creditedAmount: row.creditedAmount,
    outstanding: outstanding(row),
    status: row.status,
  };
}

/**
 * The guardian's view of fees (phase-3-financial.md slice 21, R198): a child's dues and the
 * family's receipts, for every live `can_login` link of the child (the capacity scope bound by the
 * guard), on their own DTO classes: no actor, no collector, no void reason, no other family's data
 * (§7.1, R165 extended). A receipt that also paid for a child who is not the caller's shows only
 * the caller's children's lines and the rest as one total.
 */
@Injectable()
export class MyFeesService {
  constructor(
    private readonly context: SchoolContext,
    private readonly charges: ChargeRepository,
    private readonly payments: PaymentRepository,
    private readonly receipts: ReceiptRepository,
    private readonly accounts: PaymentAccountRepository,
    private readonly clock: SchoolClock,
  ) {}

  /** GET /me/children/:id/dues. */
  async dues(session: SchoolSessionContext, studentId: bigint, query: MyDuesQueryDto): Promise<MyDuesDto> {
    requireMyChild(session, studentId);
    const schoolId = this.context.schoolId;
    const year = query.academicYearId === undefined ? undefined : BigInt(query.academicYearId);
    const open = await this.charges.openOfStudents(schoolId, [studentId], year);
    const advances = await this.payments.advances(schoolId, [studentId], year);
    const today = await this.clock.today(schoolId);
    const upcoming = open.filter((c) => c.dueOn >= today).map((c) => c.dueOn.getTime());
    return {
      studentId: studentId.toString(),
      academicYearId: year?.toString() ?? null,
      outstanding: open.reduce((sum, c) => sum + outstanding(c), 0),
      advance: advances.reduce((sum, a) => sum + a.unallocated, 0),
      nextDueOn: upcoming.length === 0 ? null : toDateString(new Date(Math.min(...upcoming))),
      charges: open.slice(0, DUES_CHARGES).map(toMyChargeDto),
      claimsAccepted: await this.accounts.anyActive(schoolId),
    };
  }

  /** GET /me/receipts: receipts with a line for one of the caller's children, newest first. */
  async receiptsOf(session: SchoolSessionContext, query: MyReceiptsQueryDto): Promise<Page<MyReceiptDto>> {
    const schoolId = this.context.schoolId;
    let children = myChildren(session);
    if (query.studentId !== undefined) {
      const studentId = BigInt(query.studentId);
      requireMyChild(session, studentId);
      children = [studentId];
    }
    const { rows, total } = await this.receipts.listForStudents(schoolId, children, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return toPage(await this.toDtos(schoolId, rows, myChildren(session)), query, total);
  }

  /** GET /me/receipts/:id: 404 unless it has a line for one of the caller's children. */
  async receipt(session: SchoolSessionContext, id: bigint): Promise<MyReceiptDto> {
    const schoolId = this.context.schoolId;
    const mine = myChildren(session);
    const row = await this.receipts.findById(schoolId, id);
    if (!row || !row.lines.some((l) => mine.includes(l.studentId))) throw notFound();
    const [dto] = await this.toDtos(schoolId, [row], mine);
    if (!dto) throw notFound();
    return dto;
  }

  private async toDtos(schoolId: SchoolId, rows: readonly ReceiptRecord[], mine: readonly bigint[]): Promise<MyReceiptDto[]> {
    if (rows.length === 0) return [];
    const payments = new Map(
      (await this.payments.findByIds(schoolId, rows.map((r) => r.paymentId))).map((p) => [p.id, p]),
    );
    const years = await this.payments.yearsByIds(schoolId, rows.map((r) => r.academicYearId));
    const names = await this.payments.students(schoolId, mine);
    return rows.map((row) => {
      const own = row.lines.filter((l) => mine.includes(l.studentId));
      const payment = payments.get(row.paymentId);
      const yearName = years.get(row.academicYearId)?.name ?? '';
      return {
        id: row.id.toString(),
        receiptLabel: receiptLabel(row.receiptNo, yearName),
        academicYearId: row.academicYearId.toString(),
        academicYearName: yearName,
        amount: row.amount,
        paidOn: payment ? toDateString(payment.receivedOn) : '',
        method: payment?.method ?? 'cash',
        lines: own.map((l) => ({
          studentId: l.studentId.toString(),
          studentName: names.get(l.studentId)?.fullName ?? '',
          feeHeadName: l.feeHeadName,
          period: l.period,
          amount: l.amount,
        })),
        otherChildrenAmount: row.amount - own.reduce((sum, l) => sum + l.amount, 0),
        issuedAt: row.issuedAt,
        voidedAt: row.voidedAt,
      };
    });
  }
}
