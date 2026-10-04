import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType, PartialType, PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, ValidateNested } from 'class-validator';
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_PRIORITIES,
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_TITLE_MAX,
  AUDIENCE_KINDS,
  AUDIENCE_ROLES,
  EXTERNAL_CHANNELS,
  INBOX_ITEM_KINDS,
  MESSAGE_PRIORITIES,
  MESSAGE_SUBJECT_TYPES,
  MESSAGE_TYPES,
  SUPPRESSION_REASONS,
  type AnnouncementCategory,
  type AnnouncementPriority,
  type AnnouncementStatus,
  type AudienceKind,
  type AudienceRole,
  type ExternalChannel,
  type InboxItemKind,
  type MessagePriority,
  type MessageSubjectType,
  type MessageType,
  type SuppressionReason,
} from '@asms/shared';
import {
  IfPresent,
  IfPresentNotNull,
  IsCalendarDate,
  NoticeBodyField,
  NoticeTextField,
  TextField,
} from '../../common/fields';
import { ID_PATTERN, IsIdString } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-14.md §2, §4.6, §5, §7. Ids are decimal strings; dates YYYY-MM-DD; instants
// ISO-8601. No field is named "read" (R150, rule 0.13).

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE = { type: String, format: 'date' } as const;
const NULLABLE_DATE = { ...DATE, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { ...DATE_TIME, nullable: true } as const;
const MIMES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
type AttachmentMime = (typeof MIMES)[number];

export const ANNOUNCEMENT_SORTS = ['-createdAt', 'createdAt', '-scheduledAt', '-sentAt'] as const;
export type AnnouncementSortValue = (typeof ANNOUNCEMENT_SORTS)[number];
export const PREVIEW_WARNINGS = ['sms_cap_short', 'sms_too_long', 'no_recipients', 'whatsapp_not_connected'] as const;
export type PreviewWarning = (typeof PREVIEW_WARNINGS)[number];

// ------------------------------------------------------------------------------- requests

/** One audience item (§2.2). Kind-dependent rules are the service's (§4.1, audiencesProblem). */
export class AudienceInputDto {
  @ApiProperty({ enum: AUDIENCE_KINDS, enumName: 'AudienceKind' })
  @IsIn(AUDIENCE_KINDS)
  kind: AudienceKind;

  @ApiPropertyOptional({ ...ID, description: 'Required for class, section, student, guardian, staff_member; forbidden otherwise' })
  @IfPresent()
  @IsIdString()
  targetId?: string;

  @ApiPropertyOptional({
    enum: AUDIENCE_ROLES,
    enumName: 'AudienceRole',
    isArray: true,
    description: 'class, section and student only; 1-2 distinct; absent = both',
  })
  @IfPresent()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(AUDIENCE_ROLES, { each: true })
  roles?: AudienceRole[];
}

/** 1-20 items (§4.1); the count is checked with the other shape rules (audiencesProblem). */
const Audiences = (): PropertyDecorator =>
  applyDecorators(
    ApiProperty({ type: () => AudienceInputDto, isArray: true, minItems: 1, maxItems: 20 }),
    IsArray(),
    ValidateNested({ each: true }),
    Type(() => AudienceInputDto),
  );

export class CreateAnnouncementDto {
  @ApiProperty({ minLength: 1, maxLength: ANNOUNCEMENT_TITLE_MAX })
  @NoticeTextField(1, ANNOUNCEMENT_TITLE_MAX)
  title: string;

  @ApiProperty({ minLength: 1, maxLength: ANNOUNCEMENT_BODY_MAX, description: 'Line breaks kept' })
  @NoticeBodyField(1, ANNOUNCEMENT_BODY_MAX)
  body: string;

  @ApiProperty({ enum: ANNOUNCEMENT_CATEGORIES, enumName: 'AnnouncementCategory' })
  @IsIn(ANNOUNCEMENT_CATEGORIES)
  category: AnnouncementCategory;

  @ApiProperty({ enum: ANNOUNCEMENT_PRIORITIES, enumName: 'AnnouncementPriority' })
  @IsIn(ANNOUNCEMENT_PRIORITIES)
  priority: AnnouncementPriority;

  @Audiences()
  audiences: AudienceInputDto[];

  @ApiPropertyOptional({ ...NULLABLE_DATE_TIME, description: 'At least 1 minute and at most 90 days ahead; takes effect at send' })
  @IfPresentNotNull()
  @IsISO8601({ strict: true })
  scheduledAt?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_DATE, description: 'Today or later; the last day it shows in an inbox' })
  @IfPresentNotNull()
  @IsCalendarDate()
  expiresOn?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'One attachment, image or PDF (POST /uploads)' })
  @IfPresentNotNull()
  @IsIdString()
  stagedUploadId?: string | null;
}

/**
 * Every create field optional; absent = unchanged (§5.7). `title`, `body`, `category`, `priority`
 * and `audiences` take no `null` (the service refuses it); the three below clear with `null`.
 */
export class UpdateAnnouncementDto extends PartialType(
  OmitType(CreateAnnouncementDto, ['scheduledAt', 'expiresOn', 'stagedUploadId'] as const),
) {
  @ApiPropertyOptional({ ...NULLABLE_DATE_TIME, description: 'null returns a scheduled announcement to draft' })
  @IfPresentNotNull()
  @IsISO8601({ strict: true })
  scheduledAt?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_DATE, description: 'null = never expires' })
  @IfPresentNotNull()
  @IsCalendarDate()
  expiresOn?: string | null;

  @ApiPropertyOptional({ ...NULLABLE_ID, description: 'null removes the attachment; a value replaces it' })
  @IfPresentNotNull()
  @IsIdString()
  stagedUploadId?: string | null;
}

export class CancelAnnouncementDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @TextField(3, 500)
  reason: string;
}

/** §4.6: the audience and priority as create takes them; title and body optional. */
export class PreviewAudienceDto extends IntersectionType(
  PickType(CreateAnnouncementDto, ['audiences', 'priority'] as const),
  PartialType(PickType(CreateAnnouncementDto, ['title', 'body'] as const)),
) {
  @ApiPropertyOptional({ type: Boolean, default: false, description: 'Preview as a holiday notice (holiday_notice)' })
  @IfPresent()
  @IsBoolean()
  holiday?: boolean;

  @ApiPropertyOptional({ type: Boolean, default: false })
  @IfPresent()
  @IsBoolean()
  hasAttachment?: boolean;
}

export class ListAnnouncementsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ANNOUNCEMENT_STATUSES, enumName: 'AnnouncementStatus' })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_STATUSES)
  status?: AnnouncementStatus;

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_CATEGORIES, enumName: 'AnnouncementCategory' })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_CATEGORIES)
  category?: AnnouncementCategory;

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_PRIORITIES, enumName: 'AnnouncementPriority' })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_PRIORITIES)
  priority?: AnnouncementPriority;

  @ApiPropertyOptional({ ...DATE, description: 'created_at as a school-local date' })
  @IsOptional()
  @IsCalendarDate()
  createdFrom?: string;

  @ApiPropertyOptional({ ...DATE, description: 'On or after createdFrom; both at most 366 days apart' })
  @IsOptional()
  @IsCalendarDate()
  createdTo?: string;

  @ApiPropertyOptional(ID)
  @IsOptional()
  @IsIdString()
  holidayId?: string;

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_SORTS, enumName: 'AnnouncementSort', default: '-createdAt' })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_SORTS)
  sort?: AnnouncementSortValue;
}

export class InboxQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: INBOX_ITEM_KINDS, enumName: 'InboxItemKind' })
  @IsOptional()
  @IsIn(INBOX_ITEM_KINDS)
  kind?: InboxItemKind;

  @ApiPropertyOptional({ enum: ANNOUNCEMENT_CATEGORIES, enumName: 'AnnouncementCategory', description: 'Announcements only' })
  @IsOptional()
  @IsIn(ANNOUNCEMENT_CATEGORIES)
  category?: AnnouncementCategory;

  @ApiPropertyOptional({ enum: ['-sentAt'], default: '-sentAt', description: 'Fixed' })
  @IsOptional()
  @IsIn(['-sentAt'])
  sort?: '-sentAt';
}

// ------------------------------------------------------------------------------ responses

export class AudienceDto {
  @ApiProperty({ enum: AUDIENCE_KINDS, enumName: 'AudienceKind' })
  kind: AudienceKind;

  @ApiProperty(NULLABLE_ID)
  targetId: string | null;

  @ApiProperty({ type: String, nullable: true })
  targetName: string | null;

  @ApiProperty({ enum: AUDIENCE_ROLES, enumName: 'AudienceRole', isArray: true })
  roles: AudienceRole[];
}

export class AnnouncementDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ enum: ANNOUNCEMENT_CATEGORIES, enumName: 'AnnouncementCategory' })
  category: AnnouncementCategory;

  @ApiProperty({ enum: ANNOUNCEMENT_PRIORITIES, enumName: 'AnnouncementPriority' })
  priority: AnnouncementPriority;

  @ApiProperty({ enum: MESSAGE_TYPES, enumName: 'MessageType' })
  messageType: MessageType;

  @ApiProperty({ enum: ANNOUNCEMENT_STATUSES, enumName: 'AnnouncementStatus' })
  status: AnnouncementStatus;

  @ApiProperty({ type: () => AudienceDto, isArray: true })
  audiences: AudienceDto[];

  @ApiProperty(NULLABLE_DATE_TIME)
  scheduledAt: Date | null;

  @ApiProperty(NULLABLE_DATE)
  expiresOn: string | null;

  @ApiProperty()
  hasAttachment: boolean;

  @ApiProperty({ enum: MIMES, nullable: true })
  attachmentMime: AttachmentMime | null;

  @ApiProperty({ type: Number, nullable: true })
  attachmentSizeBytes: number | null;

  @ApiProperty(NULLABLE_ID)
  holidayId: string | null;

  @ApiProperty(ID)
  createdBy: string;

  @ApiProperty()
  createdByName: string;

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty(DATE_TIME)
  updatedAt: Date;

  @ApiProperty(NULLABLE_DATE_TIME)
  sentAt: Date | null;

  @ApiProperty(NULLABLE_DATE_TIME)
  cancelledAt: Date | null;

  @ApiProperty(NULLABLE_ID)
  cancelledBy: string | null;

  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;

  @ApiProperty({ type: Number })
  recipientCount: number;

  @ApiProperty({
    ...NULLABLE_DATE_TIME,
    description: 'Set on a draft whose send failed five times and was given up; cleared by the next send',
  })
  sendFailedAt: Date | null;

  @ApiProperty({ type: Number, nullable: true, description: 'SMS segments per message when the type may travel by SMS now; else null' })
  smsSegments: number | null;
}

export class RecipientCountsDto {
  @ApiProperty({ type: Number }) total: number;
  @ApiProperty({ type: Number }) guardians: number;
  @ApiProperty({ type: Number }) staff: number;
  @ApiProperty({ type: Number }) students: number;
}

export class AudienceItemCountDto {
  @ApiProperty({ enum: AUDIENCE_KINDS, enumName: 'AudienceKind' })
  kind: AudienceKind;

  @ApiProperty(NULLABLE_ID)
  targetId: string | null;

  @ApiProperty({ type: String, nullable: true })
  targetName: string | null;

  @ApiProperty({ type: Number, description: 'Persons this item contributes before dedupe' })
  persons: number;
}

export class SmsPreviewDto {
  @ApiProperty() allowed: boolean;
  @ApiProperty({ type: Number }) legs: number;
  @ApiProperty({ type: Number }) segments: number;
  @ApiProperty({ type: Number }) units: number;
  @ApiProperty({ type: Number }) remaining: number;
  @ApiProperty({ type: Number }) cap: number;
}

export class AudiencePreviewDto {
  @ApiProperty({ type: () => RecipientCountsDto })
  recipients: RecipientCountsDto;

  @ApiProperty({ type: () => AudienceItemCountDto, isArray: true })
  byAudience: AudienceItemCountDto[];

  @ApiProperty({ type: () => SmsPreviewDto })
  sms: SmsPreviewDto;

  @ApiProperty({ enum: PREVIEW_WARNINGS, enumName: 'AudiencePreviewWarning', isArray: true })
  warnings: PreviewWarning[];

  @ApiProperty(DATE_TIME)
  computedAt: Date;
}

export class MessageStatusCountsDto {
  @ApiProperty({ type: Number }) queued: number;
  @ApiProperty({ type: Number }) sending: number;
  @ApiProperty({ type: Number }) sent: number;
  @ApiProperty({ type: Number }) delivered: number;
  @ApiProperty({ type: Number }) failed: number;
  @ApiProperty({ type: Number }) suppressed: number;
}

export class ChannelCountsDto {
  @ApiProperty({ enum: EXTERNAL_CHANNELS, enumName: 'ExternalChannel' })
  channel: ExternalChannel;

  @ApiProperty({ type: Number }) accepted: number;
  @ApiProperty({ type: Number }) delivered: number;
  @ApiProperty({ type: Number }) failed: number;
  @ApiProperty({ type: Number }) suppressed: number;
}

export class SuppressionCountDto {
  @ApiProperty({ enum: SUPPRESSION_REASONS, enumName: 'SuppressionReason' })
  reason: SuppressionReason;

  @ApiProperty({ type: Number })
  count: number;
}

export class DeliverySummaryDto {
  @ApiProperty(ID)
  announcementId: string;

  @ApiProperty({ enum: ANNOUNCEMENT_STATUSES, enumName: 'AnnouncementStatus' })
  status: AnnouncementStatus;

  @ApiProperty({ type: () => RecipientCountsDto })
  recipients: RecipientCountsDto;

  @ApiProperty({ type: () => MessageStatusCountsDto })
  messages: MessageStatusCountsDto;

  @ApiProperty({ type: () => ChannelCountsDto, isArray: true })
  byChannel: ChannelCountsDto[];

  @ApiProperty({ type: () => SuppressionCountDto, isArray: true })
  suppressions: SuppressionCountDto[];

  @ApiProperty({ type: Number, nullable: true })
  smsSegmentsPerMessage: number | null;

  @ApiProperty({ type: Number })
  smsUnitsReserved: number;

  @ApiProperty(DATE_TIME)
  computedAt: Date;
}

export class ViaStudentDto {
  @ApiProperty(ID)
  studentId: string;

  @ApiProperty()
  fullName: string;
}

/** R165: nothing about another student, guardian or staff member; no phone, no identity number. */
export class InboxItemDto {
  @ApiProperty({ ...ID, description: 'The message id (push messageId, app route /inbox/[messageId])' })
  id: string;

  @ApiProperty({ enum: INBOX_ITEM_KINDS, enumName: 'InboxItemKind' })
  kind: InboxItemKind;

  @ApiProperty({ enum: MESSAGE_TYPES, enumName: 'MessageType' })
  messageType: MessageType;

  @ApiProperty({ enum: MESSAGE_SUBJECT_TYPES, enumName: 'MessageSubjectType' })
  subjectType: MessageSubjectType;

  @ApiProperty(ID)
  subjectId: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ enum: ANNOUNCEMENT_CATEGORIES, enumName: 'AnnouncementCategory', nullable: true })
  category: AnnouncementCategory | null;

  @ApiProperty({ enum: MESSAGE_PRIORITIES, enumName: 'MessagePriority' })
  priority: MessagePriority;

  @ApiProperty({ ...DATE_TIME, description: 'When the school sent it' })
  sentAt: Date;

  @ApiProperty(NULLABLE_DATE)
  expiresOn: string | null;

  @ApiProperty()
  hasAttachment: boolean;

  @ApiProperty({ enum: MIMES, nullable: true })
  attachmentMime: AttachmentMime | null;

  @ApiProperty(NULLABLE_ID)
  announcementId: string | null;

  @ApiProperty({ type: () => ViaStudentDto, isArray: true })
  viaStudents: ViaStudentDto[];
}

/** One of the three stored mimes, else null (never anything the row did not store). */
export const attachmentMimeOf = (mime: string | null): AttachmentMime | null =>
  MIMES.find((known) => known === mime) ?? null;
