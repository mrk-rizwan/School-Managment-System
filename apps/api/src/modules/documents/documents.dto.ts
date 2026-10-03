import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { DOCUMENT_TYPES, type DocumentType } from '@asms/shared';
import { IsIdString, ID_PATTERN } from '../../common/ids';
import { PageQueryDto } from '../../common/pagination';

// contracts/slice-6.md §2 (StudentDocumentDto) and §6.1-§6.2. The object key never leaves the
// server: no DTO here carries it.

export const DOCUMENT_MIMES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

const ID = { type: String, pattern: ID_PATTERN.source } as const;
const DATE_TIME = { type: String, format: 'date-time' } as const;

export class StudentDocumentDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty(ID)
  studentId: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocumentType' })
  type: DocumentType;

  @ApiProperty({ enum: DOCUMENT_MIMES, enumName: 'DocumentMime' })
  mime: string;

  @ApiProperty({ type: Number, minimum: 1 })
  sizeBytes: number;

  @ApiProperty(ID)
  uploadedBy: string;

  @ApiProperty({ type: String, nullable: true })
  uploadedByName: string | null;

  @ApiProperty(DATE_TIME)
  createdAt: Date;
}

/** POST /uploads. No read endpoint exists for staged content (R41). */
export class StagedUploadDto {
  @ApiProperty(ID)
  id: string;

  @ApiProperty({ enum: DOCUMENT_MIMES, enumName: 'DocumentMime' })
  mime: string;

  @ApiProperty({ type: Number, minimum: 1 })
  sizeBytes: number;

  @ApiProperty(DATE_TIME)
  expiresAt: Date;
}

/** The multipart body of POST /uploads, for the OpenAPI document only. */
export class UploadFileDto {
  @ApiProperty({ type: 'string', format: 'binary', description: 'JPEG, PNG or PDF, at most 5 MB' })
  file: unknown;
}

export class AddDocumentDto {
  @ApiProperty(ID)
  @IsIdString()
  stagedUploadId: string;

  @ApiProperty({ enum: DOCUMENT_TYPES, enumName: 'DocumentType' })
  @IsIn(DOCUMENT_TYPES)
  type: DocumentType;
}

export class ListDocumentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_TYPES, enumName: 'DocumentType' })
  @IsOptional()
  @IsIn(DOCUMENT_TYPES)
  type?: DocumentType;

  @ApiPropertyOptional({ enum: ['-createdAt'], default: '-createdAt' })
  @IsOptional()
  @IsIn(['-createdAt'])
  sort?: '-createdAt';
}
