import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import {
  CONTACT_CAPABILITIES,
  GUARDIAN_STATUSES,
  IDENTITY_INPUT_PATTERN,
  type ContactCapability,
  type GuardianStatus,
} from '@asms/shared';
import {
  CnicField,
  EmailField,
  IfPresent,
  NameField,
  NoIdentityNumber,
  PhoneField,
  QueryBoolean,
  TextField,
  trim,
} from '../../../common/fields';
import { ID_PATTERN } from '../../../common/ids';
import { PageQueryDto } from '../../../common/pagination';

// contracts/slice-5.md §2-§3. Identity numbers are accepted in bodies only, never echoed: every
// response carries the masked form.

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const NULLABLE_ID = { ...ID, nullable: true } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;

const FullName = (): PropertyDecorator => NameField(2, 200);
const Address = (): PropertyDecorator => TextField(1, 500);
const Capability = (): PropertyDecorator => IsIn(CONTACT_CAPABILITIES);

// ------------------------------------------------------------------------------------ responses

export class GuardianDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ type: String, nullable: true, description: 'Masked, e.g. 35201-*****-1' })
  cnicMasked: string | null;

  @ApiProperty()
  hasCnic: boolean;

  @ApiProperty({ type: String, nullable: true, description: 'E.164' })
  phone: string | null;

  @ApiProperty()
  hasPhone: boolean;

  @ApiProperty({ enum: CONTACT_CAPABILITIES, enumName: 'ContactCapability' })
  contactCapability: ContactCapability;

  @ApiProperty({ enum: GUARDIAN_STATUSES, enumName: 'GuardianStatus' })
  status: GuardianStatus;

  @ApiProperty(NULLABLE_ID)
  mergedIntoId: string | null;

  @ApiProperty({ ...NULLABLE_ID, description: 'The login linked to this guardian, if any' })
  userId: string | null;

  @ApiProperty(DATE_TIME)
  createdAt: Date;

  @ApiProperty(DATE_TIME)
  updatedAt: Date;
}

export class GuardianDetailDto extends GuardianDto {
  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ type: String, nullable: true })
  address: string | null;
}

export class GuardianStudentDto {
  @ApiProperty(ID)
  linkId: string;

  @ApiProperty(ID)
  studentId: string;

  @ApiProperty()
  studentFullName: string;

  @ApiProperty()
  admissionNo: string;

  @ApiProperty()
  relationship: string;

  @ApiProperty()
  isPrimaryContact: boolean;

  @ApiProperty()
  isFeePayer: boolean;

  @ApiProperty()
  canLogin: boolean;

  @ApiProperty({ type: String, nullable: true })
  className: string | null;

  @ApiProperty({ type: String, nullable: true })
  sectionName: string | null;

  @ApiProperty({ ...DATE_TIME, nullable: true })
  linkEndedAt: Date | null;
}

export class GuardianLookupStudentDto {
  @ApiProperty(ID)
  studentId: string;

  @ApiProperty()
  fullName: string;

  @ApiProperty({ type: String, nullable: true })
  className: string | null;

  @ApiProperty()
  relationship: string;
}

export class GuardianLookupHitDto {
  @ApiProperty({ type: GuardianDto, description: 'The survivor when the hit was merged' })
  guardian: GuardianDto;

  @ApiProperty({ ...NULLABLE_ID, description: 'The merged guardian that matched, if any' })
  resolvedFromId: string | null;

  @ApiProperty({ type: [GuardianLookupStudentDto], description: 'Live links (from slice 6)' })
  students: GuardianLookupStudentDto[];
}

export class GuardianLookupResultDto {
  @ApiProperty({ type: [GuardianLookupHitDto] })
  data: GuardianLookupHitDto[];

  @ApiProperty({ description: 'More than 20 guardians matched; only the first 20 are returned' })
  truncated: boolean;
}

// --------------------------------------------------------------------------------------- inputs

export const GUARDIAN_SORTS = ['fullName', '-fullName', 'createdAt', '-createdAt'] as const;
export type GuardianSortParam = (typeof GUARDIAN_SORTS)[number];

export class ListGuardiansQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: GUARDIAN_STATUSES, enumName: 'GuardianStatus' })
  @IsOptional()
  @IsIn(GUARDIAN_STATUSES)
  status?: GuardianStatus;

  @ApiPropertyOptional({ enum: CONTACT_CAPABILITIES, enumName: 'ContactCapability' })
  @IsOptional()
  @Capability()
  contactCapability?: ContactCapability;

  @QueryBoolean()
  hasCnic?: boolean;

  @QueryBoolean()
  hasPhone?: boolean;

  @QueryBoolean()
  hasLogin?: boolean;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    description:
      'Name contains; a 4-12 digit run also matches phone. A CNIC is refused: use POST /guardians/lookup.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  @NoIdentityNumber({
    ignoreSeparators: true,
    message: '$property must not be a CNIC: use POST /guardians/lookup to find by CNIC',
  })
  q?: string;

  @ApiPropertyOptional({ enum: GUARDIAN_SORTS, enumName: 'GuardianSort', default: 'fullName' })
  @IsOptional()
  @IsIn(GUARDIAN_SORTS)
  sort?: GuardianSortParam;
}

export class ListGuardianStudentsQueryDto extends PageQueryDto {
  @QueryBoolean({ default: false })
  includeEnded?: boolean;

  @ApiPropertyOptional({ enum: ['studentFullName'], default: 'studentFullName' })
  @IsOptional()
  @IsIn(['studentFullName'])
  sort?: 'studentFullName';
}

export class CreateGuardianDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @FullName()
  fullName: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: IDENTITY_INPUT_PATTERN.source,
    description: 'CNIC, 13 digits, dashes optional. Never returned.',
  })
  @IsOptional()
  @CnicField()
  cnic?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Normalised to E.164 (+92 default)',
  })
  @IsOptional()
  @PhoneField()
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 3, maxLength: 254 })
  @IsOptional()
  @EmailField()
  email?: string | null;

  @ApiProperty({ enum: CONTACT_CAPABILITIES, enumName: 'ContactCapability' })
  @Capability()
  contactCapability: ContactCapability;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 500 })
  @IsOptional()
  @Address()
  address?: string | null;
}

/** Absent = unchanged; null = clear. fullName and contactCapability cannot be cleared. */
export class UpdateGuardianDto {
  @ApiPropertyOptional({ minLength: 2, maxLength: 200 })
  @IfPresent()
  @FullName()
  fullName?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: IDENTITY_INPUT_PATTERN.source,
    description: 'Refused with 409 GUARDIAN_CNIC_LOCKED once the guardian has a login',
  })
  @IsOptional()
  @CnicField()
  cnic?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @PhoneField()
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 3, maxLength: 254 })
  @IsOptional()
  @EmailField()
  email?: string | null;

  @ApiPropertyOptional({ enum: CONTACT_CAPABILITIES, enumName: 'ContactCapability' })
  @IfPresent()
  @Capability()
  contactCapability?: ContactCapability;

  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 500 })
  @IsOptional()
  @Address()
  address?: string | null;
}

/**
 * Exactly one of the two (checked by the service: 422 on the body root). Absent is allowed;
 * `null` is not a key and is refused on its field.
 */
export class GuardianLookupDto {
  @ApiPropertyOptional({ type: String, pattern: IDENTITY_INPUT_PATTERN.source })
  @IfPresent()
  @CnicField()
  cnic?: string;

  @ApiPropertyOptional({ type: String })
  @IfPresent()
  @PhoneField()
  phone?: string;
}
