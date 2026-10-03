import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { ContactCapability } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import type { PrismaTxAdapter } from './prisma';

// What routing needs to know about the people a message is addressed to (contracts/slice-9.md
// §7.1, §7.3): read set-based at write time, and again per person at attempt time (the processor
// sends to the person's current phone, which is never stored on the message). Read-only.

export interface GuardianContact {
  id: bigint;
  status: 'active' | 'merged';
  /** The survivor a merged guardian was folded into (rule 12). */
  mergedIntoId: bigint | null;
  phone: string | null;
  contactCapability: ContactCapability;
  /** The guardian's login, if active. */
  userId: bigint | null;
  /** The same login also carries a staff record (push idle window, contracts/slice-9.md §1.5). */
  userHasStaff: boolean;
}

export interface StaffContact {
  id: bigint;
  status: 'active' | 'suspended' | 'left';
  fullName: string;
  phone: string;
  /** The staff member's login, if active. */
  userId: bigint | null;
  /** A verified address only (predicate E). */
  verifiedEmail: string | null;
}

export interface StudentContact {
  id: bigint;
  /** An active login on an active student in a school with student logins on (capacity). */
  userId: bigint | null;
  userHasStaff: boolean;
}

const ids = (values: readonly bigint[]) => [...new Set(values)];

@Injectable()
export class MessageRecipientRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async guardians(schoolId: SchoolId, guardianIds: readonly bigint[]): Promise<GuardianContact[]> {
    if (guardianIds.length === 0) return [];
    const rows = await this.txHost.tx.guardian.findMany({
      where: { schoolId, id: { in: ids(guardianIds) } },
      select: {
        id: true,
        status: true,
        mergedIntoId: true,
        phone: true,
        contactCapability: true,
        user: { select: { id: true, status: true, staffId: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      mergedIntoId: row.mergedIntoId,
      phone: row.phone,
      contactCapability: row.contactCapability,
      userId: row.user?.status === 'active' ? row.user.id : null,
      userHasStaff: row.user?.staffId !== null && row.user?.staffId !== undefined,
    }));
  }

  async staff(schoolId: SchoolId, staffIds: readonly bigint[]): Promise<StaffContact[]> {
    if (staffIds.length === 0) return [];
    const rows = await this.txHost.tx.staff.findMany({
      where: { schoolId, id: { in: ids(staffIds) } },
      select: {
        id: true,
        status: true,
        fullName: true,
        phone: true,
        user: { select: { id: true, status: true, email: true, emailVerifiedAt: true } },
      },
    });
    return rows.map((row) => {
      const live = row.status === 'active' && row.user?.status === 'active' ? row.user : null;
      return {
        id: row.id,
        status: row.status,
        fullName: row.fullName,
        phone: row.phone,
        userId: live?.id ?? null,
        verifiedEmail: live?.email && live.emailVerifiedAt ? live.email : null,
      };
    });
  }

  /** `studentLoginEnabled` is the school's setting (SchoolSettingsRepository), read by the caller. */
  async students(
    schoolId: SchoolId,
    studentIds: readonly bigint[],
    studentLoginEnabled: boolean,
  ): Promise<StudentContact[]> {
    if (studentIds.length === 0) return [];
    const rows = await this.txHost.tx.student.findMany({
      where: { schoolId, id: { in: ids(studentIds) } },
      select: { id: true, status: true, user: { select: { id: true, status: true, staffId: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      userId:
        studentLoginEnabled &&
        row.status === 'active' &&
        row.user?.status === 'active'
          ? row.user.id
          : null,
      userHasStaff: row.user?.staffId !== null && row.user?.staffId !== undefined,
    }));
  }

  /** The staff record behind a user's login, if any (the messaging test's recipient, §5.1). */
  async staffIdOfUser(schoolId: SchoolId, userId: bigint): Promise<bigint | null> {
    const row = await this.txHost.tx.user.findFirst({
      where: { schoolId, id: userId },
      select: { staffId: true },
    });
    return row?.staffId ?? null;
  }

  /** Every active principal's staff id (the sms_cap_reached audience, §7.7). */
  async activePrincipalStaffIds(schoolId: SchoolId): Promise<bigint[]> {
    const rows = await this.txHost.tx.user.findMany({
      where: {
        schoolId,
        status: 'active',
        staff: { schoolId, status: 'active' },
        roles: { some: { schoolId, systemRole: 'principal', endedAt: null } },
      },
      select: { staffId: true },
      orderBy: { id: 'asc' },
    });
    return rows.flatMap((row) => (row.staffId === null ? [] : [row.staffId]));
  }
}
