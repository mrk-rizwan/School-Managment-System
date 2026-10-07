import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireCapacity } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../common/pagination';
import { NoQueryDto } from '../../common/validation';
import { FINANCE_READERS } from '../access/money-gates';
import { ReasonDto } from '../../common/reason.dto';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  CreatePaymentAccountDto,
  ListPaymentAccountsQueryDto,
  MyPaymentAccountDto,
  PaymentAccountDto,
} from './payment-accounts.dto';
import { PaymentAccountsService } from './payment-accounts.service';

const COMMON = [401, 403, 429];

/**
 * School payment accounts (phase-3-financial.md slice 18, rule 21). Reads for finance key
 * holders; writes need school.settings.manage and the principal role (a payee change, R233).
 */
@ApiTags('payments')
@Controller('payment-accounts')
export class PaymentAccountsController {
  constructor(private readonly accounts: PaymentAccountsService) {}

  @Get()
  @RequireCapability(...FINANCE_READERS)
  @ApiPaginated(PaymentAccountDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListPaymentAccountsQueryDto): Promise<Page<PaymentAccountDto>> {
    return this.accounts.list(query);
  }

  @Post()
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @ApiCreatedResponse({ type: PaymentAccountDto })
  @ApiErrors(...COMMON, 422)
  create(
    @Body() body: CreatePaymentAccountDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<PaymentAccountDto> {
    return this.accounts.create(session, body);
  }

  @Get(':id')
  @RequireCapability(...FINANCE_READERS)
  @ApiIdParam()
  @ApiOkResponse({ type: PaymentAccountDto })
  @ApiErrors(...COMMON, 404, 422)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<PaymentAccountDto> {
    return this.accounts.get(id);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: PaymentAccountDto })
  @ApiErrors(...COMMON, 404, 422)
  disable(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<PaymentAccountDto> {
    return this.accounts.disable(session, id, body);
  }
}

/** Where to pay (slice 18): the guardian reads the school's active accounts. */
@ApiTags('me')
@Controller('me/payment-accounts')
@RequireCapacity('guardian')
@UseGuards(MeReadsThrottleGuard)
export class MyPaymentAccountsController {
  constructor(private readonly accounts: PaymentAccountsService) {}

  @Get()
  @ApiPaginated(MyPaymentAccountDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: PageQueryDto): Promise<Page<MyPaymentAccountDto>> {
    return this.accounts.listActive(query);
  }
}
