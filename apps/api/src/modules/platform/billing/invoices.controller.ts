import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  CurrentPlatformSession,
  type PlatformSessionContext,
} from '../../../common/auth/platform-session';
import { PlatformSession } from '../../../common/auth/route-access';
import { ApiIdParam, IdParam } from '../../../common/ids';
import { ApiErrors } from '../../../common/openapi';
import { ApiPaginated, type Page } from '../../../common/pagination';
import { NoQueryDto } from '../../../common/validation';
import {
  InvoiceDto,
  IssueMonthDto,
  IssueMonthResultDto,
  ListInvoicesQueryDto,
  ReasonDto,
  RecordPlatformPaymentDto,
} from './billing.dto';
import { InvoicesService } from './invoices.service';

const COMMON = [401, 403, 429];

/** contracts/slice-26.md §1.3 (R220, R221). */
@ApiTags('platform: billing')
@Controller('platform/invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @PlatformSession('full')
  @ApiPaginated(InvoiceDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListInvoicesQueryDto): Promise<Page<InvoiceDto>> {
    return this.invoices.list(query);
  }

  /** The monthly run on demand: idempotent per school and month. */
  @Post('issue-month')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiOkResponse({ type: IssueMonthResultDto })
  @ApiErrors(...COMMON, 422)
  issueMonth(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @Body() body: IssueMonthDto,
    @Query() _query: NoQueryDto,
  ): Promise<IssueMonthResultDto> {
    return this.invoices.issueMonth(session.userId, body.yearMonth);
  }

  @Get(':id')
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: InvoiceDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<InvoiceDto> {
    return this.invoices.get(id);
  }

  @Post(':id/record-payment')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: InvoiceDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  recordPayment(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: RecordPlatformPaymentDto,
    @Query() _query: NoQueryDto,
  ): Promise<InvoiceDto> {
    return this.invoices.recordPayment(session.userId, id, body);
  }

  @Post(':id/void')
  @HttpCode(200)
  @PlatformSession('full')
  @ApiIdParam()
  @ApiOkResponse({ type: InvoiceDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  void(
    @CurrentPlatformSession() session: PlatformSessionContext,
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
  ): Promise<InvoiceDto> {
    return this.invoices.void(session.userId, id, body.reason);
  }
}
