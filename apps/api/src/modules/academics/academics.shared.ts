// Pieces shared by the four academic-structure resources (contracts/slice-3.md §1).
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../../common/errors/api-exception';
import { IfPresent, TextField } from '../../common/fields';

/** The body of every archive action (§3.5, §4.5, §5.5). */
export class ArchiveDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @TextField(3, 500)
  reason?: string;
}

// ----------------------------------------------------------------------------------- errors

/** 422 with one field error (an id in a body that does not resolve, a value refused in context). */
export const fieldRefused = (path: string, code: ErrorCode, message: string): ApiException =>
  new ApiException(422, ErrorCode.VALIDATION_FAILED, 'Some fields are invalid.', {
    fields: [{ path, code, message }],
  });

export const yearClosed = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.ACADEMIC_YEAR_CLOSED,
    'A closed academic year cannot be changed.',
  );

export const classArchived = (): ApiException =>
  new ApiException(409, ErrorCode.CLASS_ARCHIVED, 'An archived class cannot be changed.');

// ------------------------------------------------------------------------------------ dates

/** A `date` column value (UTC midnight) as `YYYY-MM-DD`. */
export const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

/** A validated `YYYY-MM-DD` as the UTC midnight Prisma writes to a `date` column. */
export const fromDateString = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Change metadata for an audit row: only the fields whose value differs. */
export type Changes = Record<string, { from: string | number | null; to: string | number | null }>;
