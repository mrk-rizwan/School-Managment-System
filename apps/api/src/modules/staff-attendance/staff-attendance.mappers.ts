import type { StaffMarkView } from '../../repositories/staff-attendance.repository';
import { toDateString } from '../academics/academics.shared';
import type { StaffMarkDto } from './staff-attendance.dto';

// Row → DTO for the staff attendance routes (contracts/slice-12.md §2). Ids travel as strings.

export function toStaffMarkDto(row: StaffMarkView): StaffMarkDto {
  return {
    id: row.id.toString(),
    staffId: row.staffId.toString(),
    date: toDateString(row.date),
    status: row.status,
    note: row.note,
    markedBy: row.markedBy?.toString() ?? null,
    markedByName: row.markedByName,
    markedAt: row.markedAt,
    amended: row.lastAmendedAt !== null,
    lastAmendedAt: row.lastAmendedAt,
    lastAmendedByName: row.lastAmendedByName,
  };
}
