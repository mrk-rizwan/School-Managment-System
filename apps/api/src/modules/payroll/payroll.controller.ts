import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireStaff } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { notFound } from '../../common/errors/api-exception';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, PageQueryDto, type Page } from '../../common/pagination';
import { sendPrintView } from '../../common/print-view';
import { NoQueryDto } from '../../common/validation';
import { ReasonDto } from '../../common/reason.dto';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  AddPayslipDto,
  AdjustPayslipDto,
  AdvanceDto,
  CreateAdvanceDto,
  CreateSalaryStructureDto,
  FinaliseRunDto,
  ListAdvancesQueryDto,
  MarkPayslipPaidDto,
  MySalaryStructureDto,
  PayrollRunDto,
  PayslipDto,
  PrepareRunDto,
  SalaryStructureDto,
} from './payroll.dto';
import { PayrollRunsService } from './payroll-runs.service';
import { SalaryAdvancesService } from './salary-advances.service';
import { SalaryStructuresService } from './salary-structures.service';

// phase-3-financial.md slice 25; contracts/slice-25.md §1. Common to every route: 401, 403, 429.
const COMMON = [401, 403, 429];

/**
 * A print view's 200 (text/html). Declared as the response's own content, not with @ApiProduces,
 * which would make the error envelope (the default response) text/html too.
 */
const PRINT_VIEW_RESPONSE = {
  description: 'The printable payslip (R237)',
  content: { 'text/html': { schema: { type: 'string' } } },
} as const;

const IDEMPOTENCY_HEADER_DOC = {
  name: IDEMPOTENCY_HEADER,
  required: true,
  description:
    '16-64 of A-Z a-z 0-9 _ -, generated once when the form opens (newIdempotencyKey()); a replay answers 200 with Idempotency-Replayed: true',
} as const;

const replayed = (outcome: { replayed: boolean }, res: Response, created: boolean): void => {
  if (outcome.replayed) {
    res.status(200);
    res.setHeader('Idempotency-Replayed', 'true');
  } else if (!created) {
    res.status(200);
  }
};

/** The caller's own staff id (@RequireStaff admits only an active staff capacity). */
const ownStaffId = (session: SchoolSessionContext): bigint => {
  const staffId = session.access.staffId;
  if (staffId === null) throw notFound();
  return staffId;
};

/** A staff member's salary (R213): read by contract managers and payroll readers. */
@ApiTags('payroll')
@Controller('staff')
export class StaffSalaryController {
  constructor(private readonly structures: SalaryStructuresService) {}

  @Get(':id/salary-structure')
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE, Capability.PAYROLL_VIEW)
  @ApiIdParam()
  @ApiPaginated(SalaryStructureDto)
  @ApiErrors(...COMMON, 404, 422)
  list(@IdParam() id: bigint, @Query() query: PageQueryDto): Promise<Page<SalaryStructureDto>> {
    return this.structures.listForStaff(id, query);
  }

  /** 201; 200 for a replay of the same key and body. Never one's own (R235, R253). */
  @Post(':id/salary-structure')
  @RequireCapability(Capability.STAFF_CONTRACT_MANAGE)
  @UseGuards(IdempotencyKeyGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: SalaryStructureDto })
  @ApiOkResponse({ type: SalaryStructureDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async create(
    @IdParam() id: bigint,
    @Body() body: CreateSalaryStructureDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SalaryStructureDto> {
    const outcome = await this.structures.create(session, id, body, req.header(IDEMPOTENCY_HEADER));
    replayed(outcome, res, true);
    return outcome.structure;
  }
}

/** Salary advances (R215): read with payroll.view; granted and written off by the principal. */
@ApiTags('payroll')
@Controller('salary-advances')
export class SalaryAdvancesController {
  constructor(private readonly advances: SalaryAdvancesService) {}

  @Get()
  @RequireCapability(Capability.PAYROLL_VIEW)
  @ApiPaginated(AdvanceDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListAdvancesQueryDto): Promise<Page<AdvanceDto>> {
    return this.advances.list(query);
  }

  /** payroll.run and the principal role (R233); never one's own (R235). */
  @Post()
  @RequireCapability(Capability.PAYROLL_RUN)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: AdvanceDto })
  @ApiOkResponse({ type: AdvanceDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateAdvanceDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdvanceDto> {
    const outcome = await this.advances.create(session, body, req.header(IDEMPOTENCY_HEADER));
    replayed(outcome, res, true);
    return outcome.advance;
  }

  @Get(':id')
  @RequireCapability(Capability.PAYROLL_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: AdvanceDto })
  @ApiErrors(...COMMON, 404)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<AdvanceDto> {
    return this.advances.get(id);
  }

  @Post(':id/write-off')
  @HttpCode(200)
  @RequireCapability(Capability.PAYROLL_RUN)
  @ApiIdParam()
  @ApiOkResponse({ type: AdvanceDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  writeOff(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<AdvanceDto> {
    return this.advances.writeOff(session, id, body);
  }
}

/** The monthly run (R214, R216): prepare, review, recompute, finalise. */
@ApiTags('payroll')
@Controller('payroll-runs')
export class PayrollRunsController {
  constructor(private readonly runs: PayrollRunsService) {}

  @Get()
  @RequireCapability(Capability.PAYROLL_VIEW)
  @ApiPaginated(PayrollRunDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: PageQueryDto): Promise<Page<PayrollRunDto>> {
    return this.runs.list(query);
  }

  @Post()
  @RequireCapability(Capability.PAYROLL_RUN)
  @ApiCreatedResponse({ type: PayrollRunDto })
  @ApiErrors(...COMMON, 409, 422)
  prepare(@Body() body: PrepareRunDto, @Query() _query: NoQueryDto): Promise<PayrollRunDto> {
    return this.runs.prepare(body);
  }

  @Get(':id')
  @RequireCapability(Capability.PAYROLL_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: PayrollRunDto })
  @ApiErrors(...COMMON, 404)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<PayrollRunDto> {
    return this.runs.get(id);
  }

  /** By staff name; a draft's payslips carry the days behind each count. */
  @Get(':id/payslips')
  @RequireCapability(Capability.PAYROLL_VIEW)
  @ApiIdParam()
  @ApiPaginated(PayslipDto)
  @ApiErrors(...COMMON, 404, 422)
  payslips(@IdParam() id: bigint, @Query() query: PageQueryDto): Promise<Page<PayslipDto>> {
    return this.runs.listPayslips(id, query);
  }

  /** R216: an empty payslip for someone the draft does not pay, to carry a correction. */
  @Post(':id/payslips')
  @RequireCapability(Capability.PAYROLL_RUN)
  @ApiIdParam()
  @ApiCreatedResponse({ type: PayslipDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  addPayslip(@IdParam() id: bigint, @Body() body: AddPayslipDto, @Query() _query: NoQueryDto): Promise<PayslipDto> {
    return this.runs.addPayslip(id, body);
  }

  @Post(':id/recompute')
  @HttpCode(200)
  @RequireCapability(Capability.PAYROLL_RUN)
  @ApiIdParam()
  @ApiOkResponse({ type: PayrollRunDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  recompute(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<PayrollRunDto> {
    return this.runs.recompute(id);
  }

  @Post(':id/finalise')
  @HttpCode(200)
  @RequireCapability(Capability.PAYROLL_RUN)
  @ApiIdParam()
  @ApiOkResponse({ type: PayrollRunDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  finalise(
    @IdParam() id: bigint,
    @Body() body: FinaliseRunDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<PayrollRunDto> {
    return this.runs.finalise(session, id, body);
  }
}

/** Payslips (R216-R218): read with payroll.view; adjusted and marked paid with payroll.run. */
@ApiTags('payroll')
@Controller('payslips')
export class PayslipsController {
  constructor(private readonly runs: PayrollRunsService) {}

  @Get(':id')
  @RequireCapability(Capability.PAYROLL_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: PayslipDto })
  @ApiErrors(...COMMON, 404)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<PayslipDto> {
    return this.runs.getPayslip(id);
  }

  /** R237: sendPrintView, escaped and scriptless. */
  @Get(':id/print')
  @RequireCapability(Capability.PAYROLL_VIEW)
  @ApiIdParam()
  @ApiOkResponse(PRINT_VIEW_RESPONSE)
  @ApiErrors(...COMMON, 404)
  async print(@IdParam() id: bigint, @Query() _query: NoQueryDto, @Res() res: Response): Promise<void> {
    sendPrintView(res, await this.runs.print(await this.runs.getPayslip(id)));
  }

  /** 200 with the payslip; a replay of the same key and body is 200 too, Idempotency-Replayed. */
  @Post(':id/adjust')
  @RequireCapability(Capability.PAYROLL_RUN)
  @UseGuards(IdempotencyKeyGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiOkResponse({ type: PayslipDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  async adjust(
    @IdParam() id: bigint,
    @Body() body: AdjustPayslipDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PayslipDto> {
    const outcome = await this.runs.adjust(session, id, body, req.header(IDEMPOTENCY_HEADER));
    replayed(outcome, res, false);
    return outcome.payslip;
  }

  @Post(':id/mark-paid')
  @HttpCode(200)
  @RequireCapability(Capability.PAYROLL_RUN)
  @ApiIdParam()
  @ApiOkResponse({ type: PayslipDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  markPaid(@IdParam() id: bigint, @Body() body: MarkPayslipPaidDto, @Query() _query: NoQueryDto): Promise<PayslipDto> {
    return this.runs.markPaid(id, body);
  }
}

/** A staff member's own salary and payslips: the staff id is the session's, never input (R217). */
@ApiTags('me')
@Controller('me/staff')
export class MyPayrollController {
  constructor(
    private readonly structures: SalaryStructuresService,
    private readonly runs: PayrollRunsService,
  ) {}

  @Get('salary-structure')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiOkResponse({ type: MySalaryStructureDto })
  @ApiErrors(...COMMON)
  salary(@CurrentSchoolSession() session: SchoolSessionContext, @Query() _query: NoQueryDto): Promise<MySalaryStructureDto> {
    return this.structures.mine(ownStaffId(session));
  }

  /** Payslips of finalised runs only, newest month first. */
  @Get('payslips')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiPaginated(PayslipDto)
  @ApiErrors(...COMMON, 422)
  payslips(@CurrentSchoolSession() session: SchoolSessionContext, @Query() query: PageQueryDto): Promise<Page<PayslipDto>> {
    return this.runs.listMine(ownStaffId(session), query);
  }

  @Get('payslips/:id')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: PayslipDto })
  @ApiErrors(...COMMON, 404)
  payslip(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
  ): Promise<PayslipDto> {
    return this.runs.getMine(ownStaffId(session), id);
  }

  /** R237: the own payslip through sendPrintView. */
  @Get('payslips/:id/print')
  @RequireStaff()
  @UseGuards(MeReadsThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(PRINT_VIEW_RESPONSE)
  @ApiErrors(...COMMON, 404)
  async print(
    @CurrentSchoolSession() session: SchoolSessionContext,
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    sendPrintView(res, await this.runs.print(await this.runs.getMine(ownStaffId(session), id)));
  }
}
