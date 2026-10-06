import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { NoQueryDto } from '../../common/validation';
import { binaryOf, IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import { sendAttachment } from '../documents/documents.controller';
import { ReasonDto } from '../fees/fees.dto';
import {
  ApproveExpenseDto,
  CreateExpenseDto,
  ExpenseDto,
  ExpenseReceiptDto,
  ListExpensesQueryDto,
  RejectExpenseDto,
  UpdateExpenseDto,
} from './expenses.dto';
import { ExpensesService } from './expenses.service';

// phase-3-financial.md slice 23; contracts/slice-23.md §1. Common to every route: 401, 403
// PERMISSION_DENIED / ORIGIN_REJECTED, 426 (bearer), 429.
const COMMON = [401, 403, 429];

/** Who may read expenses (§5 slice 23): recorders, approvers and report readers, school-wide. */
const EXPENSE_READERS: [Capability, ...Capability[]] = [
  Capability.EXPENSE_RECORD,
  Capability.EXPENSE_APPROVE,
  Capability.FINANCE_REPORT_VIEW,
];

/** Receipt and thumbnail reads: 120/min, 2,000/hour per user, as the diary's files. */
export const ExpenseFilesThrottleGuard = perUserThrottle('expense-files', 120, 2000);

@ApiTags('expenses')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequireCapability(...EXPENSE_READERS)
  @ApiPaginated(ExpenseDto)
  @ApiErrors(...COMMON, 422)
  list(@Query() query: ListExpensesQueryDto): Promise<Page<ExpenseDto>> {
    return this.expenses.list(query);
  }

  /** 201 recorded, pending or self-approved (R206); 200 for a replay of the same key and body. */
  @Post()
  @RequireCapability(Capability.EXPENSE_RECORD)
  @UseGuards(IdempotencyKeyGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: ExpenseDto })
  @ApiOkResponse({ type: ExpenseDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async create(
    @Body() body: CreateExpenseDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExpenseDto> {
    const outcome = await this.expenses.create(session, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.expense;
  }

  @Get(':id')
  @RequireCapability(...EXPENSE_READERS)
  @ApiIdParam()
  @ApiOkResponse({ type: ExpenseDto })
  @ApiErrors(...COMMON, 404)
  get(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<ExpenseDto> {
    return this.expenses.get(id);
  }

  /** The recorder, while recorded or pending (not_recorder, EXPENSE_NOT_OPEN). */
  @Patch(':id')
  @RequireCapability(Capability.EXPENSE_RECORD)
  @ApiIdParam()
  @ApiOkResponse({ type: ExpenseDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  update(
    @IdParam() id: bigint,
    @Body() body: UpdateExpenseDto,
    @Query() _query: NoQueryDto,
  ): Promise<ExpenseDto> {
    return this.expenses.update(id, body);
  }

  /** Set once by the recorder; the same upload again is 200, another EXPENSE_RECEIPT_EXISTS. */
  @Patch(':id/receipt')
  @RequireCapability(Capability.EXPENSE_RECORD)
  @ApiIdParam()
  @ApiOkResponse({ type: ExpenseDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  attachReceipt(
    @IdParam() id: bigint,
    @Body() body: ExpenseReceiptDto,
    @Query() _query: NoQueryDto,
  ): Promise<ExpenseDto> {
    return this.expenses.attachReceipt(id, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequireCapability(Capability.EXPENSE_APPROVE)
  @ApiIdParam()
  @ApiOkResponse({ type: ExpenseDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  approve(
    @IdParam() id: bigint,
    @Body() body: ApproveExpenseDto,
    @Query() _query: NoQueryDto,
  ): Promise<ExpenseDto> {
    return this.expenses.approve(id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequireCapability(Capability.EXPENSE_APPROVE)
  @ApiIdParam()
  @ApiOkResponse({ type: ExpenseDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  reject(@IdParam() id: bigint, @Body() body: RejectExpenseDto, @Query() _query: NoQueryDto): Promise<ExpenseDto> {
    return this.expenses.reject(id, body);
  }

  /** The recorder while open; an `expense.approve` holder once approved (R244). */
  @Post(':id/void')
  @HttpCode(200)
  @RequireCapability(Capability.EXPENSE_RECORD, Capability.EXPENSE_APPROVE)
  @ApiIdParam()
  @ApiOkResponse({ type: ExpenseDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  void(
    @IdParam() id: bigint,
    @Body() body: ReasonDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<ExpenseDto> {
    return this.expenses.void(session, id, body);
  }

  /** R208: streamed to expense readers, never a URL; `nosniff`, `CSP sandbox`, `no-store`. */
  @Get(':id/receipt')
  @RequireCapability(...EXPENSE_READERS)
  @UseGuards(ExpenseFilesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg', 'image/png', 'application/pdf'))
  @ApiErrors(...COMMON, 404)
  async receipt(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.expenses.receipt(id, false);
    res.setHeader('Cache-Control', 'no-store');
    return sendAttachment(res, file.body, file);
  }

  /** An image receipt at most 320 × 320; a PDF has none (404). */
  @Get(':id/receipt/thumbnail')
  @RequireCapability(...EXPENSE_READERS)
  @UseGuards(ExpenseFilesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse(binaryOf('image/jpeg'))
  @ApiErrors(...COMMON, 404, 503)
  async thumbnail(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.expenses.receipt(id, true);
    res.setHeader('Cache-Control', 'no-store');
    return sendAttachment(res, file.body, file);
  }
}
