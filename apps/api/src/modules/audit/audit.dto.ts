import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { IsCalendarDate } from '../../common/fields';
import { IsIdString, ID_PATTERN } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// Phase 5 slice 46, the audit screen (contracts/slice-46.md §1-§2; rule 40, R354).

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE = { type: String, format: 'date', example: '2026-10-14' } as const;

/** A subject type as audit_log stores it (varchar 32, lower snake case). */
export const SUBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** An action family (`payment`) or a prefix of an action (`payment.ref`). */
export const ACTION_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,40}(\.[a-z0-9_]{0,40})?$/;

/**
 * GET /audit-log. One of three filters is required (422 otherwise, §2.1): `actorUserId`, the pair
 * `subjectType` + `subjectId`, or the pair `createdFrom` + `createdTo` (school calendar dates,
 * inclusive, at most 92 days). `actionPrefix` narrows any of them. Sorted `-createdAt`.
 */
export class ListAuditLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ ...ID, description: 'The acting school user' })
  @IsOptional()
  @IsIdString()
  actorUserId?: string;

  @ApiPropertyOptional({ type: String, pattern: SUBJECT_TYPE_PATTERN.source, description: 'With subjectId' })
  @IsOptional()
  @Matches(SUBJECT_TYPE_PATTERN)
  subjectType?: string;

  @ApiPropertyOptional({ ...ID, description: 'With subjectType' })
  @IsOptional()
  @IsIdString()
  subjectId?: string;

  @ApiPropertyOptional({ ...DATE, description: 'With createdTo; inclusive' })
  @IsOptional()
  @IsCalendarDate()
  createdFrom?: string;

  @ApiPropertyOptional({ ...DATE, description: 'With createdFrom; inclusive; at most 92 days on' })
  @IsOptional()
  @IsCalendarDate()
  createdTo?: string;

  @ApiPropertyOptional({
    type: String,
    pattern: ACTION_PREFIX_PATTERN.source,
    description: 'A family (`payment`, meaning `payment.*`) or the start of an action (`payment.ref`)',
  })
  @IsOptional()
  @Matches(ACTION_PREFIX_PATTERN)
  actionPrefix?: string;
}

export const AUDIT_ACTOR_KINDS = ['user', 'platform', 'system'] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** Who acted: a school user by name, the platform as "Platform support", a job as "System". */
export class AuditActorDto {
  @ApiProperty({ enum: AUDIT_ACTOR_KINDS, enumName: 'AuditActorKind' }) kind: AuditActorKind;
  /** The school user (kind `user`); never a platform user's id. */
  @ApiProperty({ ...ID, nullable: true }) userId: string | null;
  @ApiProperty() name: string;
}

/** One metadata value as text (nested keys joined with `.`), identity, phone and email shapes masked. */
export class AuditDetailDto {
  @ApiProperty() key: string;
  @ApiProperty() value: string;
}

/** One audit_log row as the screen shows it (R354). */
export class AuditEntryDto {
  @ApiProperty(ID) id: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: Date;
  @ApiProperty() action: string;
  @ApiProperty() subjectType: string;
  @ApiProperty({ ...ID, nullable: true }) subjectId: string | null;
  @ApiProperty({ type: () => AuditActorDto }) actor: AuditActorDto;
  /** Masked like the details. */
  @ApiProperty({ type: String, nullable: true }) reason: string | null;
  @ApiProperty({ type: () => AuditDetailDto, isArray: true }) details: AuditDetailDto[];
}
