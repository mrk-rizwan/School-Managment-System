import { Injectable } from '@nestjs/common';
import { Capability } from '@asms/shared';
import type { SchoolSessionContext } from '../../common/auth/school-session';
import type { Page } from '../../common/pagination';
import { PermissionsService } from '../access/permissions.service';
import { ListExpensesQueryDto } from '../expenses/expenses.dto';
import { ExpensesService } from '../expenses/expenses.service';
import { ListLeaveRequestsQueryDto } from '../leave/leave.dto';
import { LeaveRequestsService } from '../leave/leave-requests.service';
import { CashHandoversService } from '../payments/cash-handovers.service';
import { ListClaimsQueryDto } from '../payments/claims.dto';
import { ClaimsService } from '../payments/claims.service';
import { ListHandoversQueryDto } from '../payments/payments.dto';
import { ResultSheetsService } from '../results/result-sheets.service';
import { ListResultSheetsQueryDto } from '../results/results.dto';
import type { ApprovalsDto } from './approvals.dto';

/** The first page of each section (phase-3-financial.md slice 27). */
export const APPROVALS_PAGE_SIZE = 10;

const section = <T>(page: Page<T>) => ({ count: page.total, items: page.data });

/** The queue's own query DTO, first page of ten, with the queue's pending filter. */
function firstPage<Q extends { page: number; limit: number }>(Dto: new () => Q, filter: Partial<Q>): Q {
  return Object.assign(new Dto(), filter, { page: 1, limit: APPROVALS_PAGE_SIZE });
}

/**
 * GET /me/approvals (R227): the four decision queues the caller may act on, each read through the
 * queue's own list method, so its rows, order, row scope and separation-of-duties behaviour are
 * exactly the queue's (an own-family claim stays listed, as in the queue, and is refused on
 * decision). No new query: `count` is the list's own total. A section is present only when the
 * caller holds its key; the reads run one after another (no Promise.all on one connection).
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly claims: ClaimsService,
    private readonly handovers: CashHandoversService,
    private readonly expenses: ExpensesService,
    private readonly leave: LeaveRequestsService,
    private readonly resultSheets: ResultSheetsService,
  ) {}

  async forCaller(session: SchoolSessionContext): Promise<ApprovalsDto> {
    const holds = (capability: Capability) => this.permissions.holds(session.access, capability);
    const dto: ApprovalsDto = {};
    if (holds(Capability.PAYMENT_VERIFY)) {
      // The queue's defaults: pending, with the slip (R243), oldest first.
      dto.claims = section(await this.claims.list(firstPage(ListClaimsQueryDto, {})));
    }
    if (holds(Capability.COLLECTION_HANDOVER_CONFIRM)) {
      dto.handovers = section(await this.handovers.list(firstPage(ListHandoversQueryDto, { status: 'open' })));
    }
    if (holds(Capability.EXPENSE_APPROVE)) {
      dto.expenses = section(
        await this.expenses.list(firstPage(ListExpensesQueryDto, { status: 'pending_approval' })),
      );
    }
    if (holds(Capability.STAFF_LEAVE_APPROVE)) {
      dto.leave = section(await this.leave.list(firstPage(ListLeaveRequestsQueryDto, { status: 'pending' })));
    }
    if (holds(Capability.RESULT_APPROVE)) {
      // R278: exactly GET /result-sheets?status=submitted for the holder (its default sort).
      dto.results = section(
        await this.resultSheets.list(session, firstPage(ListResultSheetsQueryDto, { status: 'submitted' })),
      );
    }
    return dto;
  }
}
