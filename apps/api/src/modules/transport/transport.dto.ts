import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, Matches, Max, Min, ValidateNested } from 'class-validator';
import { TIME_OF_DAY, VEHICLE_CAPACITY_MAX } from '@asms/shared';
import {
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  IsYearMonth,
  NameField,
  QueryBoolean,
  Reason,
  Rupees,
  SearchField,
} from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// Phase 5 slice 41 (contracts/slice-41.md §1). Ids are strings; dates `YYYY-MM-DD`; periods
// `YYYY-MM`; pickup times `HH:MM` in school time; amounts whole rupees.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date', example: '2026-11-01' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const NULLABLE_TEXT = { type: String, nullable: true } as const;
const PERIOD = { type: String, pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$', example: '2026-11' } as const;
const TIME = { type: String, pattern: TIME_OF_DAY.source, description: 'HH:MM, school time', example: '07:10' } as const;
const NULLABLE_TIME = { ...TIME, nullable: true } as const;
const RUPEES = { type: Number, minimum: 0, description: 'Whole rupees' } as const;
/** A route's live stops: at most 100 (CHECK transport_stops_sort_order_check). */
export const MAX_STOPS = 100;

export const VEHICLE_FILTERS = ['active', 'retired', 'all'] as const;
export type VehicleFilter = (typeof VEHICLE_FILTERS)[number];
export const ROUTE_FILTERS = ['active', 'archived', 'all'] as const;
export type RouteFilter = (typeof ROUTE_FILTERS)[number];
/** Against the school's today: `upcoming` starts later, `ended` has its end set, else `live`. */
export const ASSIGNMENT_STATUSES = ['live', 'upcoming', 'ended'] as const;
export type TransportAssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

// ------------------------------------------------------------------------------------ responses

export class VehicleDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() registration: string;
  @ApiProperty({ type: Number, minimum: 1, maximum: VEHICLE_CAPACITY_MAX }) capacity: number;
  @ApiProperty(NULLABLE_ID) driverStaffId: string | null;
  @ApiProperty(NULLABLE_TEXT) driverName: string | null;
  @ApiProperty({ enum: ['active', 'retired'], enumName: 'VehicleStatus' }) status: 'active' | 'retired';
  @ApiProperty({ type: [String], description: 'The active routes it serves' }) routeNames: string[];
  @ApiProperty(NULLABLE_DATE_TIME) retiredAt: Date | null;
  @ApiProperty(NULLABLE_TEXT) retireReason: string | null;
  @ApiProperty(DATE_TIME) createdAt: Date;
}

export class TransportStopDto {
  @ApiProperty(ID) id: string;
  @ApiProperty({ type: Number, minimum: 1, maximum: MAX_STOPS }) sortOrder: number;
  @ApiProperty() name: string;
  @ApiProperty(NULLABLE_TIME) pickupTime: string | null;
}

export class RouteVehicleDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() registration: string;
  @ApiProperty({ type: Number }) capacity: number;
  @ApiProperty(NULLABLE_TEXT) driverName: string | null;
}

export class NextRouteAmountDto {
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty(PERIOD) effectivePeriod: string;
}

export class TransportRouteDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['active', 'archived'], enumName: 'TransportRouteStatus' }) status: 'active' | 'archived';
  @ApiProperty({ type: RouteVehicleDto, nullable: true }) vehicle: RouteVehicleDto | null;
  @ApiProperty({ type: Number, description: 'Live assignments' }) riders: number;
  @ApiProperty({ ...RUPEES, nullable: true, description: 'The amount in force this period' }) currentAmount: number | null;
  @ApiProperty({ type: NextRouteAmountDto, nullable: true, description: 'A live amount from a later period' })
  nextAmount: NextRouteAmountDto | null;
  @ApiProperty({ type: Number }) stopCount: number;
  @ApiProperty(NULLABLE_DATE_TIME) archivedAt: Date | null;
  @ApiProperty(NULLABLE_TEXT) archiveReason: string | null;
}

export class TransportRouteAmountDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) routeId: string;
  @ApiProperty(PERIOD) effectivePeriod: string;
  @ApiProperty(RUPEES) amount: number;
  @ApiProperty(NULLABLE_TEXT) createdByName: string | null;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty(NULLABLE_DATE_TIME) voidedAt: Date | null;
  @ApiProperty(NULLABLE_TEXT) voidReason: string | null;
  @ApiProperty({ description: 'Live and its period not yet started' }) voidable: boolean;
}

export class TransportRouteDetailDto extends TransportRouteDto {
  @ApiProperty({ type: [TransportStopDto] }) stops: TransportStopDto[];
  @ApiProperty({ type: [TransportRouteAmountDto], description: 'Newest period first, voided included' })
  amounts: TransportRouteAmountDto[];
}

export class TransportAssignmentDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) studentId: string;
  @ApiProperty() studentName: string;
  @ApiProperty() admissionNo: string;
  @ApiProperty(NULLABLE_TEXT) className: string | null;
  @ApiProperty(NULLABLE_TEXT) sectionName: string | null;
  @ApiProperty(ID) academicYearId: string;
  @ApiProperty(ID) routeId: string;
  @ApiProperty() routeName: string;
  @ApiProperty(NULLABLE_ID) stopId: string | null;
  @ApiProperty(NULLABLE_TEXT) stopName: string | null;
  @ApiProperty(NULLABLE_TIME) pickupTime: string | null;
  @ApiProperty(DATE) startsOn: string;
  @ApiProperty({ ...NULLABLE_DATE, description: 'The last day on the route' }) endsOn: string | null;
  @ApiProperty({ enum: ASSIGNMENT_STATUSES, enumName: 'TransportAssignmentStatus' }) status: TransportAssignmentStatus;
  @ApiProperty(NULLABLE_TEXT) endReason: string | null;
  @ApiProperty(NULLABLE_TEXT) endedByName: string | null;
  @ApiProperty(DATE_TIME) createdAt: Date;
}

export class CapacityWarningDto {
  @ApiProperty({ type: Number }) capacity: number;
  @ApiProperty({ type: Number, description: 'Live riders on the route, this one included' }) riders: number;
}

export class TransportAssignmentCreatedDto extends TransportAssignmentDto {
  @ApiProperty({ type: CapacityWarningDto, nullable: true, description: 'R331: over capacity warns, never blocks' })
  capacityWarning: CapacityWarningDto | null;
}

export class StudentTransportDto {
  @ApiProperty({ type: TransportAssignmentDto, nullable: true }) current: TransportAssignmentDto | null;
  @ApiProperty({ type: [TransportAssignmentDto], description: 'Earlier assignments, newest first (at most 20)' })
  history: TransportAssignmentDto[];
}

export class MyTransportItemDto {
  @ApiProperty() routeName: string;
  @ApiProperty(NULLABLE_TEXT) stopName: string | null;
  @ApiProperty(NULLABLE_TIME) pickupTime: string | null;
  @ApiProperty(NULLABLE_TEXT) driverName: string | null;
  @ApiProperty(DATE) startsOn: string;
  @ApiProperty(NULLABLE_DATE) endsOn: string | null;
}

export class MyTransportDto {
  @ApiProperty({ type: MyTransportItemDto, nullable: true }) current: MyTransportItemDto | null;
}

export class DriverRiderDto {
  @ApiProperty() name: string;
  @ApiProperty(NULLABLE_ID) stopId: string | null;
}

export class MyDriverRouteDto {
  @ApiProperty(ID) id: string;
  @ApiProperty() name: string;
  @ApiProperty() vehicleRegistration: string;
  @ApiProperty({ type: [TransportStopDto] }) stops: TransportStopDto[];
  @ApiProperty({ type: [DriverRiderDto] }) students: DriverRiderDto[];
}

// ------------------------------------------------------------------------------------- requests

export class ListVehiclesQueryDto extends PageQueryDto {
  @SearchField('Part of the registration', 20)
  registration?: string;

  @ApiPropertyOptional({ enum: VEHICLE_FILTERS, enumName: 'VehicleFilter', default: 'active' })
  @IsOptional()
  @IsIn(VEHICLE_FILTERS)
  status?: VehicleFilter;
}

export class CreateVehicleDto {
  @ApiProperty({ minLength: 1, maxLength: 20, example: 'LES-1234' })
  @NameField(1, 20)
  registration: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: VEHICLE_CAPACITY_MAX })
  @IsInt()
  @Min(1)
  @Max(VEHICLE_CAPACITY_MAX)
  capacity: number;

  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  driverStaffId?: string;
}

export class UpdateVehicleDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 20 })
  @IfPresent()
  @NameField(1, 20)
  registration?: string;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: VEHICLE_CAPACITY_MAX })
  @IfPresent()
  @IsInt()
  @Min(1)
  @Max(VEHICLE_CAPACITY_MAX)
  capacity?: number;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'null removes the driver' })
  @IfPresentNotNull()
  @IsIdString()
  driverStaffId?: string | null;
}

export class StopInputDto {
  @ApiPropertyOptional({ ...ID, description: 'A live stop of the route, edited in place; absent adds one' })
  @IfPresent()
  @IsIdString()
  id?: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: MAX_STOPS })
  @IsInt()
  @Min(1)
  @Max(MAX_STOPS)
  sortOrder: number;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @NameField(1, 80)
  name: string;

  @ApiPropertyOptional(TIME)
  @IfPresent()
  @Matches(TIME_OF_DAY, { message: '$property must be HH:MM' })
  pickupTime?: string;
}

export class ListRoutesQueryDto extends PageQueryDto {
  @SearchField('Part of the route name')
  name?: string;

  @ApiPropertyOptional({ enum: ROUTE_FILTERS, enumName: 'TransportRouteFilter', default: 'active' })
  @IsOptional()
  @IsIn(ROUTE_FILTERS)
  status?: RouteFilter;
}

export class CreateTransportRouteDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @NameField(1, 80)
  name: string;

  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  vehicleId?: string;

  @ApiPropertyOptional({ type: [StopInputDto], maxItems: MAX_STOPS, description: 'New stops (no id)' })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_STOPS)
  @ValidateNested({ each: true })
  @Type(() => StopInputDto)
  stops?: StopInputDto[];
}

export class UpdateTransportRouteDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IfPresent()
  @NameField(1, 80)
  name?: string;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'null removes the vehicle' })
  @IfPresentNotNull()
  @IsIdString()
  vehicleId?: string | null;

  @ApiPropertyOptional({
    type: [StopInputDto],
    maxItems: MAX_STOPS,
    description: 'The live stops as a whole: listed ones are kept or added, the rest end (needs reason)',
  })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(MAX_STOPS)
  @ValidateNested({ each: true })
  @Type(() => StopInputDto)
  stops?: StopInputDto[];

  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required when a stop ends' })
  @IfPresent()
  @Reason()
  reason?: string;
}

export class SetRouteAmountDto {
  @ApiProperty(RUPEES)
  @Rupees()
  amount: number;

  @ApiProperty({ ...PERIOD, description: 'The next period or later (a route with no amount in force may start now)' })
  @IsYearMonth()
  effectivePeriod: string;
}

export class ListRouteAssignmentsQueryDto extends PageQueryDto {
  @QueryBoolean({ default: false, description: 'Ended assignments too' })
  includeEnded?: boolean;

  @SearchField('Part of the student’s name')
  studentName?: string;
}

export class CreateTransportAssignmentDto {
  @ApiProperty(ID)
  @IsIdString()
  studentId: string;

  @ApiPropertyOptional(ID)
  @IfPresent()
  @IsIdString()
  stopId?: string;

  @ApiProperty(DATE)
  @IsCalendarDate()
  startsOn: string;
}

export class EndTransportAssignmentDto {
  @ApiProperty({ ...DATE, description: 'The last day on the route (startsOn − 1: never in force)' })
  @IsCalendarDate()
  endedOn: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}
