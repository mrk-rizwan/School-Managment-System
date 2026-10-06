import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import type { Request, Response } from 'express';
import { RequireCapability, RequireStaff } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../common/pagination';
import { sendPrintView } from '../../common/print-view';
import { perUserThrottle } from '../../common/rate-limit';
import { SchoolClock } from '../../common/school-clock';
import { NoQueryDto } from '../../common/validation';
import { ReasonDto } from '../fees/fees.dto';
import { CashHandoversService } from './cash-handovers.service';
import { PaymentReversalsService } from './payment-reversals.service';
import {
  CarryForwardDto,
  CarryForwardResultDto,
  ConfirmHandoverDto,
  CreatePaymentDto,
  CustodyDto,
  GuardianDuesDto,
  HandoverDto,
  ListHandoversQueryDto,
  ListPaymentsQueryDto,
  OpenHandoverDto,
  OpenHandoverOnBehalfDto,
  PaymentDto,
  PaymentIntentDto,
  PaymentPreviewDto,
  ReceiptDto,
  RefundDto,
  ResolveShortfallDto,
  ReversalDto,
  ReverseRefundDto,
} from './payments.dto';
import { PaymentsService } from './payments.service';
import { receiptPage } from './receipt-print';

// phase-3-financial.md slice 20 (contracts/slice-20.md §1). Common to every route: 401
// AUTH_REQUIRED, 403 PERMISSION_DENIED / ORIGIN_REJECTED, 429. Teachers reach none of it (R234).
const COMMON = [401, 403, 429];

const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -, generated once when the form opens (newIdempotencyKey()); a replay answers 200 with Idempotency-Replayed: true',
} as const;

/** §5 named throttle: the counter's preview, 60/min and 600/h per user. */
export const PaymentPreviewThrottleGuard = perUserThrottle('payment-preview', 60, 600);

/** A keyed create: 201, or 200 with Idempotency-Replayed on a replay. */
function replayed(res: Response, outcome: { replayed: boolean }): void {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  }
}

const READERS = [Capability.PAYMENT_RECORD, Capability.FEE_STATEMENT_VIEW] as const;

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly reversals: PaymentReversalsService,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @RequireCapability(Capability.PAYMENT_RECORD)
  @UseGuards(PaymentPreviewThrottleGuard)
  @ApiOkResponse({ type: PaymentPreviewDto })
  @ApiErrors(...COMMON, 409, 422)
  preview(@Body() body: PaymentIntentDto, @Query() _query: NoQueryDto): Promise<PaymentPreviewDto> {
    return this.payments.preview(body);
  }

  @Post()
  @RequireCapability(Capability.PAYMENT_RECORD)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: PaymentDto })
  @ApiOkResponse({ type: PaymentDto, description: 'Replay of a committed payment' })
  @ApiErrors(...COMMON, 409, 422)
  async record(
    @Body() body: CreatePaymentDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const outcome = await this.payments.record(body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.payment;
  }

  @Get()
  @RequireCapability(...READERS)
  @ApiPaginated(PaymentDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListPaymentsQueryDto): Promise<Page<PaymentDto>> {
    return this.payments.list(query);
  }

  @Get(':id')
  @RequireCapability(...READERS)
  @ApiIdParam()
  @ApiOkResponse({ type: PaymentDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<PaymentDto> {
    return this.payments.get(id);
  }

  /** R191: never by the recorder; refused inside an open handover and while a refund stands. */
  @Post(':id/void')
  @HttpCode(200)
  @RequireCapability(Capability.PAYMENT_VOID)
  @ApiIdParam()
  @ApiOkResponse({ type: PaymentDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  void(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<PaymentDto> {
    return this.reversals.void(id, body);
  }

  /** R192: payment.void and the principal role. */
  @Post(':id/refund')
  @RequireCapability(Capability.PAYMENT_VOID)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: ReversalDto })
  @ApiOkResponse({ type: ReversalDto, description: 'Replay of a committed refund' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async refund(
    @IdParam() id: bigint,
    @Body() body: RefundDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReversalDto> {
    const outcome = await this.reversals.refund(session, id, body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.value;
  }

  @Post(':id/reverse-refund')
  @RequireCapability(Capability.PAYMENT_VOID)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: ReversalDto })
  @ApiOkResponse({ type: ReversalDto, description: 'Replay of a committed refund reversal' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async reverseRefund(
    @IdParam() id: bigint,
    @Body() body: ReverseRefundDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReversalDto> {
    const outcome = await this.reversals.reverseRefund(session, id, body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.value;
  }

  /** R251: the advance moved to another academic year; no cash moves. */
  @Post(':id/carry-forward')
  @RequireCapability(Capability.PAYMENT_RECORD)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiIdParam()
  @ApiCreatedResponse({ type: CarryForwardResultDto })
  @ApiOkResponse({ type: CarryForwardResultDto, description: 'Replay of a committed carry-forward' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async carryForward(
    @IdParam() id: bigint,
    @Body() body: CarryForwardDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CarryForwardResultDto> {
    const outcome = await this.reversals.carryForward(id, body, req.header(IDEMPOTENCY_HEADER));
    replayed(res, outcome);
    return outcome.value;
  }
}

@ApiTags('payments')
@Controller('receipts')
export class ReceiptsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly clock: SchoolClock,
  ) {}

  @Get(':id')
  @RequireCapability(...READERS)
  @ApiIdParam()
  @ApiOkResponse({ type: ReceiptDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ReceiptDto> {
    return this.payments.receipt(id);
  }

  /** R237: the printable page, through sendPrintView only. */
  @Get(':id/print')
  @RequireCapability(...READERS)
  @ApiIdParam()
  @ApiOkResponse({ description: 'The printable receipt (R237)', content: { 'text/html': { schema: { type: 'string' } } } })
  @ApiErrors(...COMMON, 404, 422)
  async print(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Res() res: Response,
  ): Promise<void> {
    const { receipt, payment } = await this.payments.receiptForPrint(id);
    sendPrintView(res, receiptPage(session.school.name, receipt, payment, await this.clock.timezone(session.schoolId)));
  }
}

@ApiTags('payments')
@Controller('guardians')
export class GuardianDuesController {
  constructor(private readonly payments: PaymentsService) {}

  /** The counter's first screen (bounded: ten children, fifty open charges each). */
  @Get(':id/dues')
  @RequireCapability(...READERS)
  @ApiIdParam()
  @ApiOkResponse({ type: GuardianDuesDto })
  @ApiErrors(...COMMON, 404, 422)
  dues(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<GuardianDuesDto> {
    return this.payments.guardianDues(id);
  }
}

@ApiTags('payments')
@Controller('cash-handovers')
export class CashHandoversController {
  constructor(
    private readonly handovers: CashHandoversService,
    private readonly payments: PaymentsService,
  ) {}

  /** A13: on behalf of a collector who has left or is suspended; a third user confirms. */
  @Post()
  @RequireCapability(Capability.COLLECTION_HANDOVER_CONFIRM)
  @ApiCreatedResponse({ type: HandoverDto })
  @ApiErrors(...COMMON, 409, 422)
  openOnBehalf(@Body() body: OpenHandoverOnBehalfDto, @Query() _query: NoQueryDto): Promise<HandoverDto> {
    return this.handovers.openOnBehalf(body);
  }

  @Get()
  @RequireCapability(Capability.COLLECTION_HANDOVER_CONFIRM)
  @ApiPaginated(HandoverDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListHandoversQueryDto): Promise<Page<HandoverDto>> {
    return this.handovers.list(query);
  }

  @Get(':id')
  @RequireCapability(Capability.COLLECTION_HANDOVER_CONFIRM)
  @ApiIdParam()
  @ApiOkResponse({ type: HandoverDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<HandoverDto> {
    return this.handovers.get(id);
  }

  @Get(':id/payments')
  @RequireCapability(Capability.COLLECTION_HANDOVER_CONFIRM)
  @ApiIdParam()
  @ApiPaginated(PaymentDto)
  @ApiErrors(...COMMON, 404, 422)
  async handoverPayments(@IdParam() id: bigint, @Query() query: PageQueryDto): Promise<Page<PaymentDto>> {
    await this.handovers.exists(id);
    return this.payments.ofHandover(id, query);
  }

  /** R194: never the collector, never the opener. */
  @Post(':id/confirm')
  @HttpCode(200)
  @RequireCapability(Capability.COLLECTION_HANDOVER_CONFIRM)
  @ApiIdParam()
  @ApiOkResponse({ type: HandoverDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  confirm(@IdParam() id: bigint, @Body() body: ConfirmHandoverDto, @Query() _query: NoQueryDto): Promise<HandoverDto> {
    return this.handovers.confirm(id, body);
  }

  /** §3.4: collection.handover.confirm and the principal role. */
  @Post(':id/resolve-shortfall')
  @HttpCode(200)
  @RequireCapability(Capability.COLLECTION_HANDOVER_CONFIRM)
  @ApiIdParam()
  @ApiOkResponse({ type: HandoverDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  resolve(
    @IdParam() id: bigint,
    @Body() body: ResolveShortfallDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<HandoverDto> {
    return this.handovers.resolve(session, id, body);
  }
}

/** The caller's own custody and handovers; the user and staff ids come from the session only. */
@ApiTags('me')
@Controller('me/staff')
export class MyCustodyController {
  constructor(private readonly handovers: CashHandoversService) {}

  @Get('custody')
  @RequireStaff()
  @ApiOkResponse({ type: CustodyDto })
  @ApiErrors(...COMMON)
  custody(@Query() _query: NoQueryDto): Promise<CustodyDto> {
    return this.handovers.custody();
  }

  @Get('cash-handovers')
  @RequireStaff()
  @ApiPaginated(HandoverDto)
  @ApiErrors(...COMMON, 422)
  mine(@Query() query: PageQueryDto): Promise<Page<HandoverDto>> {
    return this.handovers.mine(query);
  }

  /** The collector hands over their own custody (payment.record). */
  @Post('cash-handovers')
  @RequireCapability(Capability.PAYMENT_RECORD)
  @ApiCreatedResponse({ type: HandoverDto })
  @ApiErrors(...COMMON, 409, 422)
  open(
    @Body() body: OpenHandoverDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<HandoverDto> {
    return this.handovers.openOwn(session, body);
  }
}
