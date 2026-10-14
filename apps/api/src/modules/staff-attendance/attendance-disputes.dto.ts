import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  DISPUTE_STATUSES,
  STAFF_ATTENDANCE_SOURCES,
  STAFF_ATTENDANCE_STATUSES,
  type DisputeStatus,
  type StaffAttendanceSource,
  type StaffAttendanceStatus,
} from '@asms/shared';
import { IfPresent, Reason } from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-44.md §1, §2.5, §2.6 (R346, R347).

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const STATUS = { enum: STAFF_ATTENDANCE_STATUSES, enumName: 'StaffAttendanceStatus' } as const;
const DISPUTE_STATUS = { enum: DISPUTE_STATUSES, enumName: 'DisputeStatus' } as const;
const NULLABLE_STRING = { type: String, nullable: true } as const;

export class AttendanceDisputeDto {
  @ApiProperty(ID) id: string;
  @ApiProperty(ID) attendanceId: string;
  @ApiProperty(ID) staffId: string;
  @ApiProperty() staffName: string;
  @ApiProperty({ type: String, format: 'date', description: 'The disputed day' }) date: string;
  @ApiProperty({ ...STATUS, description: 'The mark’s status now' }) markStatus: StaffAttendanceStatus;
  @ApiProperty({ enum: STAFF_ATTENDANCE_SOURCES, enumName: 'StaffAttendanceSource' })
  markSource: StaffAttendanceSource;
  @ApiProperty(STATUS) requestedStatus: StaffAttendanceStatus;
  @ApiProperty({ maxLength: 500 }) reason: string;
  @ApiProperty(DISPUTE_STATUS) status: DisputeStatus;
  @ApiProperty(DATE_TIME) createdAt: Date;
  @ApiProperty(NULLABLE_STRING) decidedByName: string | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) decidedAt: Date | null;
  @ApiProperty({ ...NULLABLE_STRING, maxLength: 500 }) decisionReason: string | null;
  @ApiProperty({ ...DATE_TIME, nullable: true }) withdrawnAt: Date | null;
}

export class RaiseDisputeDto {
  @ApiProperty({ ...ID, description: 'One of the caller’s own marks (GET /me/staff/attendance markId)' })
  @IsIdString()
  attendanceId: string;

  @ApiProperty({ ...STATUS, description: 'What the mark should say; not what it says now' })
  @IsIn(STAFF_ATTENDANCE_STATUSES)
  requestedStatus: StaffAttendanceStatus;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Reason()
  reason: string;
}

export class ApproveDisputeDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @Reason()
  reason?: string;
}

export class ListMyDisputesQueryDto extends PageQueryDto {
  @ApiPropertyOptional(DISPUTE_STATUS)
  @IsOptional()
  @IsIn(DISPUTE_STATUSES)
  status?: DisputeStatus;
}

export class ListDisputesQueryDto extends ListMyDisputesQueryDto {
  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  staffId?: string;
}
