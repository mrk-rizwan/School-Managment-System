import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireCapacity, RequireStaff } from '../../common/auth/route-access';
import { CurrentSchoolSession, type SchoolSessionContext } from '../../common/auth/school-session';
import { IDEMPOTENCY_HEADER, IdempotencyKeyGuard } from '../../common/idempotency';
import { ApiIdParam, IdParam } from '../../common/ids';
import { ApiErrors } from '../../common/openapi';
import { ApiPaginated, type Page } from '../../common/pagination';
import { perUserThrottle } from '../../common/rate-limit';
import { ReasonDto } from '../../common/reason.dto';
import { NoQueryDto } from '../../common/validation';
import { IDEMPOTENCY_HEADER_DOC } from '../diary/diary.controller';
import { MeReadsThrottleGuard } from '../me/me-throttles';
import {
  CreateTransportAssignmentDto,
  CreateTransportRouteDto,
  CreateVehicleDto,
  EndTransportAssignmentDto,
  ListRouteAssignmentsQueryDto,
  ListRoutesQueryDto,
  ListVehiclesQueryDto,
  MyDriverRouteDto,
  MyTransportDto,
  SetRouteAmountDto,
  StudentTransportDto,
  TransportAssignmentCreatedDto,
  TransportAssignmentDto,
  TransportRouteAmountDto,
  TransportRouteDetailDto,
  TransportRouteDto,
  UpdateTransportRouteDto,
  UpdateVehicleDto,
  VehicleDto,
} from './transport.dto';
import { TransportAssignmentsService } from './transport-assignments.service';
import { TransportService } from './transport.service';

// Phase 5 slice 41 (contracts/slice-41.md §1). Common to every route: 401, 403 PERMISSION_DENIED /
// ORIGIN_REJECTED, 426 (bearer), 429. Set-up and assignments need transport.manage (principal and
// office by default); the families and the driver read their own under /me.
const COMMON = [401, 403, 429];

/** Every transport write: 30/min, 300/hour per user. */
export const TransportWritesThrottleGuard = perUserThrottle('transport-writes', 30, 300);

@ApiTags('transport')
@Controller()
export class TransportController {
  constructor(
    private readonly transport: TransportService,
    private readonly assignments: TransportAssignmentsService,
  ) {}

  // ---------------------------------------------------------------------------------- vehicles

  @Get('vehicles')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @ApiPaginated(VehicleDto)
  @ApiErrors(...COMMON, 422)
  listVehicles(@Query() query: ListVehiclesQueryDto): Promise<Page<VehicleDto>> {
    return this.transport.listVehicles(query);
  }

  /** 201; 200 for a replay of the same key and body. */
  @Post('vehicles')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(IdempotencyKeyGuard, TransportWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: VehicleDto })
  @ApiOkResponse({ type: VehicleDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async createVehicle(
    @Body() body: CreateVehicleDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleDto> {
    const outcome = await this.transport.createVehicle(body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.vehicle;
  }

  @Patch('vehicles/:id')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: VehicleDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  updateVehicle(@IdParam() id: bigint, @Body() body: UpdateVehicleDto, @Query() _query: NoQueryDto): Promise<VehicleDto> {
    return this.transport.updateVehicle(id, body);
  }

  @Post('vehicles/:id/retire')
  @HttpCode(200)
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: VehicleDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  retireVehicle(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<VehicleDto> {
    return this.transport.retireVehicle(id, body.reason);
  }

  // ------------------------------------------------------------------------------------ routes

  @Get('transport-routes')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @ApiPaginated(TransportRouteDto)
  @ApiErrors(...COMMON, 422)
  listRoutes(@Query() query: ListRoutesQueryDto): Promise<Page<TransportRouteDto>> {
    return this.transport.listRoutes(query);
  }

  /** 201; 200 for a replay of the same key and body. */
  @Post('transport-routes')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(IdempotencyKeyGuard, TransportWritesThrottleGuard)
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: TransportRouteDetailDto })
  @ApiOkResponse({ type: TransportRouteDetailDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 409, 422)
  async createRoute(
    @Body() body: CreateTransportRouteDto,
    @Query() _query: NoQueryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransportRouteDetailDto> {
    const outcome = await this.transport.createRoute(body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.route;
  }

  @Get('transport-routes/:id')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @ApiIdParam()
  @ApiOkResponse({ type: TransportRouteDetailDto })
  @ApiErrors(...COMMON, 404)
  getRoute(@IdParam() id: bigint, @Query() _query: NoQueryDto): Promise<TransportRouteDetailDto> {
    return this.transport.getRoute(id);
  }

  /** Name, vehicle and the live stops as a whole (contracts/slice-41.md §2.2). */
  @Patch('transport-routes/:id')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: TransportRouteDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  updateRoute(@IdParam() id: bigint, @Body() body: UpdateTransportRouteDto, @Query() _query: NoQueryDto): Promise<TransportRouteDetailDto> {
    return this.transport.updateRoute(id, body);
  }

  @Post('transport-routes/:id/archive')
  @HttpCode(200)
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: TransportRouteDetailDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  archiveRoute(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<TransportRouteDetailDto> {
    return this.transport.archiveRoute(id, body.reason);
  }

  @Post('transport-routes/:id/amounts')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiCreatedResponse({ type: TransportRouteAmountDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  setAmount(@IdParam() id: bigint, @Body() body: SetRouteAmountDto, @Query() _query: NoQueryDto): Promise<TransportRouteAmountDto> {
    return this.transport.setAmount(id, body);
  }

  @Post('transport-route-amounts/:id/void')
  @HttpCode(200)
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: TransportRouteAmountDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  voidAmount(@IdParam() id: bigint, @Body() body: ReasonDto, @Query() _query: NoQueryDto): Promise<TransportRouteAmountDto> {
    return this.transport.voidAmount(id, body.reason);
  }

  // ------------------------------------------------------------------------------- assignments

  @Get('transport-routes/:id/assignments')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @ApiIdParam()
  @ApiPaginated(TransportAssignmentDto)
  @ApiErrors(...COMMON, 404, 422)
  listAssignments(
    @IdParam() id: bigint,
    @Query() query: ListRouteAssignmentsQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<Page<TransportAssignmentDto>> {
    return this.assignments.listForRoute(session, id, query);
  }

  /** 201; 200 for a replay of the same key and body (R326). Over capacity warns (R331). */
  @Post('transport-routes/:id/assignments')
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(IdempotencyKeyGuard, TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiHeader(IDEMPOTENCY_HEADER_DOC)
  @ApiCreatedResponse({ type: TransportAssignmentCreatedDto })
  @ApiOkResponse({ type: TransportAssignmentCreatedDto, description: 'Replay of a committed create' })
  @ApiErrors(...COMMON, 404, 409, 422)
  async createAssignment(
    @IdParam() id: bigint,
    @Body() body: CreateTransportAssignmentDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransportAssignmentCreatedDto> {
    const outcome = await this.assignments.create(session, id, body, req.header(IDEMPOTENCY_HEADER));
    if (outcome.replayed) {
      res.status(200);
      res.setHeader('Idempotency-Replayed', 'true');
    }
    return outcome.assignment;
  }

  @Post('transport-assignments/:id/end')
  @HttpCode(200)
  @RequireCapability(Capability.TRANSPORT_MANAGE)
  @UseGuards(TransportWritesThrottleGuard)
  @ApiIdParam()
  @ApiOkResponse({ type: TransportAssignmentDto })
  @ApiErrors(...COMMON, 404, 409, 422)
  endAssignment(
    @IdParam() id: bigint,
    @Body() body: EndTransportAssignmentDto,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<TransportAssignmentDto> {
    return this.assignments.end(session, id, body);
  }

  /** The student page's Transport card: anyone who sees the student (scoped) or runs transport. */
  @Get('students/:id/transport')
  @RequireCapability(Capability.TRANSPORT_MANAGE, Capability.STUDENT_VIEW)
  @ApiIdParam()
  @ApiOkResponse({ type: StudentTransportDto })
  @ApiErrors(...COMMON, 404)
  forStudent(
    @IdParam() id: bigint,
    @Query() _query: NoQueryDto,
    @CurrentSchoolSession() session: SchoolSessionContext,
  ): Promise<StudentTransportDto> {
    return this.assignments.forStudent(session, id);
  }
}

/** The family and driver reads (R330): every /me/* read takes the me-reads bucket. */
@ApiTags('me')
@Controller('me')
@UseGuards(MeReadsThrottleGuard)
export class MyTransportController {
  constructor(private readonly assignments: TransportAssignmentsService) {}

  @Get('children/:id/transport')
  @RequireCapacity('guardian')
  @ApiIdParam()
  @ApiOkResponse({ type: MyTransportDto })
  @ApiErrors(...COMMON, 404)
  child(@IdParam() id: bigint, @Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<MyTransportDto> {
    return this.assignments.family(session, id);
  }

  @Get('student/transport')
  @RequireCapacity('student')
  @ApiOkResponse({ type: MyTransportDto })
  @ApiErrors(...COMMON, 404)
  own(@Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<MyTransportDto> {
    return this.assignments.family(session, null);
  }

  /** The routes whose vehicle names the caller as driver: names and stops only. */
  @Get('staff/transport-routes')
  @RequireStaff()
  @ApiOkResponse({ type: [MyDriverRouteDto] })
  @ApiErrors(...COMMON)
  driver(@Query() _query: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext): Promise<MyDriverRouteDto[]> {
    return this.assignments.driverRoutes(session);
  }
}
