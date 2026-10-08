// Pieces shared by the four academic-structure resources (contracts/slice-3.md §1).
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ErrorCode } from '@asms/shared';
import { ApiException, notFound } from '../../common/errors/api-exception';
import { IfPresent, TextField } from '../../common/fields';
import { assertRange } from '../../common/school-clock';
import type {
  AcademicYearRecord,
  AcademicYearRepository,
} from '../../repositories/academic-year.repository';
import type { SchoolId } from '../../tenancy/school-id';

/** The body of every archive action (§3.5, §4.5, §5.5). */
export class ArchiveDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IfPresent()
  @TextField(3, 500)
  reason?: string;
}

// ----------------------------------------------------------------------------------- errors

export const yearClosed = (): ApiException =>
  new ApiException(
    409,
    ErrorCode.ACADEMIC_YEAR_CLOSED,
    'A closed academic year cannot be changed.',
  );

/** The academic year, open: 404 when unknown, ACADEMIC_YEAR_CLOSED when closed. */
export async function requireOpenYear(
  years: Pick<AcademicYearRepository, 'findById'>,
  schoolId: SchoolId,
  id: bigint,
): Promise<AcademicYearRecord> {
  const year = await years.findById(schoolId, id);
  if (!year) throw notFound();
  if (year.status === 'closed') throw yearClosed();
  return year;
}

export const classArchived = (): ApiException =>
  new ApiException(409, ErrorCode.CLASS_ARCHIVED, 'An archived class cannot be changed.');

/** Phase 4 slice 29 (contracts/slice-29.md §5): a term overlapping another of its year. */
export const termOverlaps = (termId: bigint | null): ApiException =>
  new ApiException(409, ErrorCode.TERM_OVERLAPS, 'This overlaps another term of the year.', {
    termId: termId?.toString() ?? null,
  });

/** A term outside its year, or a year whose new dates would leave a term outside. */
export const termOutsideYear = (termId: bigint | null): ApiException =>
  new ApiException(409, ErrorCode.TERM_OUTSIDE_YEAR, 'A term must lie inside its academic year.', {
    termId: termId?.toString() ?? null,
  });

export const termNameTaken = (): ApiException =>
  new ApiException(409, ErrorCode.TERM_NAME_TAKEN, 'The year already has a term of that name.', {
    field: 'name',
  });

// ------------------------------------------------------------------------------------ dates

/** A `date` column value (UTC midnight) as `YYYY-MM-DD`. */
export const toDateString = (date: Date): string => date.toISOString().slice(0, 10);

/** A validated `YYYY-MM-DD` as the UTC midnight Prisma writes to a `date` column. */
export const fromDateString = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** A required `dateFrom`/`dateTo` pair as DATE values, checked by assertRange (422 on dateTo). */
export function parseRange(dateFrom: string, dateTo: string, maxDays: number): { from: Date; to: Date } {
  const from = fromDateString(dateFrom);
  const to = fromDateString(dateTo);
  assertRange(from, to, maxDays);
  return { from, to };
}

/** Change metadata for an audit row: only the fields whose value differs. */
export type Changes = Record<string, { from: string | number | null; to: string | number | null }>;
