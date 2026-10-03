import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SchoolId } from '../tenancy/school-id';
import type { Prisma, StudentStatus } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

// contracts/slice-6.md §3.3, §3.6. The append-only table student_status_changes (trigger
// student_status_changes_append_only): rows are inserted, never changed. `fromStatus` is null only
// for the admission row (CHECK student_status_changes_transition_check); `reason` never holds an
// identity number (CHECK student_status_changes_reason_no_id_check; TextField refuses one first).
//
// Shared interface (slice 6B's admission and readmission call it inside their transaction; keep
// the signature stable):
//   record(schoolId, data: StatusChangeCreate): Promise<StatusChangeRecord>

export interface StatusChangeRecord {
  id: bigint;
  studentId: bigint;
  fromStatus: StudentStatus | null;
  toStatus: StudentStatus;
  reason: string | null;
  changedBy: bigint;
  /** UTC midnight of the calendar date (a `date` column). */
  effectiveOn: Date;
  createdAt: Date;
}

/** A status change with the display name of the user who made it. */
export interface StatusChangeView extends StatusChangeRecord {
  changedByName: string;
}

export interface StatusChangeCreate {
  studentId: bigint;
  /** Null for the admission row only. */
  fromStatus: StudentStatus | null;
  toStatus: StudentStatus;
  reason: string | null;
  changedBy: bigint;
  effectiveOn: Date;
}

const SELECT = {
  id: true,
  studentId: true,
  fromStatus: true,
  toStatus: true,
  reason: true,
  changedBy: true,
  effectiveOn: true,
  createdAt: true,
} satisfies Prisma.StudentStatusChangeSelect;

@Injectable()
export class StudentStatusChangeRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  record(schoolId: SchoolId, data: StatusChangeCreate): Promise<StatusChangeRecord> {
    return this.txHost.tx.studentStatusChange.create({
      data: { schoolId, ...data },
      select: SELECT,
    });
  }

  /** The most recent change of the student (by effective date, then insertion), if any. */
  latestForStudent(schoolId: SchoolId, studentId: bigint): Promise<StatusChangeRecord | null> {
    return this.txHost.tx.studentStatusChange.findFirst({
      where: { schoolId, studentId },
      select: SELECT,
      orderBy: [{ effectiveOn: 'desc' }, { id: 'desc' }],
    });
  }

  /** Newest first. The caller has checked the student is in scope. */
  async listForStudent(
    schoolId: SchoolId,
    studentId: bigint,
    page: { skip: number; take: number },
  ): Promise<{ rows: StatusChangeView[]; total: number }> {
    const where = { schoolId, studentId };
    const rows = await this.txHost.tx.studentStatusChange.findMany({
      where,
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    });
    const total = await this.txHost.tx.studentStatusChange.count({ where });
    return { rows: await this.withNames(schoolId, rows), total };
  }

  /**
   * The display name of each change's user: staff name, else guardian name (as the users screen
   * shows it). Sequential statements (§3.3).
   */
  private async withNames(
    schoolId: SchoolId,
    rows: StatusChangeRecord[],
  ): Promise<StatusChangeView[]> {
    if (rows.length === 0) return [];
    const users = await this.txHost.tx.user.findMany({
      where: { schoolId, id: { in: [...new Set(rows.map((r) => r.changedBy))] } },
      select: { id: true, staffId: true, guardianId: true },
    });
    const staffIds = users.flatMap((u) => (u.staffId === null ? [] : [u.staffId]));
    const guardianIds = users.flatMap((u) => (u.guardianId === null ? [] : [u.guardianId]));
    const staff =
      staffIds.length === 0
        ? []
        : await this.txHost.tx.staff.findMany({
            where: { schoolId, id: { in: staffIds } },
            select: { id: true, fullName: true },
          });
    const guardians =
      guardianIds.length === 0
        ? []
        : await this.txHost.tx.guardian.findMany({
            where: { schoolId, id: { in: guardianIds } },
            select: { id: true, fullName: true },
          });
    const staffNames = new Map(staff.map((s) => [s.id, s.fullName]));
    const guardianNames = new Map(guardians.map((g) => [g.id, g.fullName]));
    const names = new Map(
      users.map((u) => [
        u.id,
        (u.staffId === null ? undefined : staffNames.get(u.staffId)) ??
          (u.guardianId === null ? undefined : guardianNames.get(u.guardianId)) ??
          '',
      ]),
    );
    return rows.map((row) => ({ ...row, changedByName: names.get(row.changedBy) ?? '' }));
  }
}
