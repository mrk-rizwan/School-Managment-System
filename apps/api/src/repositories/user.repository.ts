import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { SystemRole } from '@asms/shared';
import type { SchoolId } from '../tenancy/school-id';
import { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';

export type UserStatusValue = 'active' | 'disabled';
export type StaffStatusValue = 'active' | 'suspended' | 'left';

/** What the permission service needs to derive capacities and capabilities (contract §1.1). */
export interface UserAccessRow {
  id: bigint;
  status: UserStatusValue;
  staffId: bigint | null;
  guardianId: bigint | null;
  staffStatus: StaffStatusValue | null;
  /** Live (not ended) system-role rows. */
  systemRoles: SystemRole[];
}

/** The credential fields of a user, as login and the password flows read them. */
export interface UserCredentialRow {
  id: bigint;
  usernameHash: string;
  passwordHash: string;
  status: UserStatusValue;
  email: string | null;
  emailVerifiedAt: Date | null;
  passwordIsDefault: boolean;
  lastLoginAt: Date | null;
  officeResetAt: Date | null;
  staffId: bigint | null;
  guardianId: bigint | null;
}

/** A user as the users screen and /me show it. */
export interface UserRecord {
  id: bigint;
  staffId: bigint | null;
  guardianId: bigint | null;
  fullName: string;
  systemRoles: SystemRole[];
  status: UserStatusValue;
  email: string | null;
  emailVerifiedAt: Date | null;
  passwordIsDefault: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export type UserSortField = 'fullName' | 'lastLoginAt' | 'createdAt';
export type UserSort = UserSortField | `-${UserSortField}`;

export interface UserListQuery {
  status?: UserStatusValue;
  passwordIsDefault?: boolean;
  hasEmail?: boolean;
  kind?: 'staff' | 'guardian' | 'student';
  /** Trimmed, 2-100 characters, no 13-digit run (the DTO's job). */
  q?: string;
  sort: UserSort;
  skip: number;
  take: number;
}

const CREDENTIAL_SELECT = {
  id: true,
  usernameHash: true,
  passwordHash: true,
  status: true,
  email: true,
  emailVerifiedAt: true,
  passwordIsDefault: true,
  lastLoginAt: true,
  officeResetAt: true,
  staffId: true,
  guardianId: true,
} as const satisfies Prisma.UserSelect;

// Scalars only. Relations are read by separate, sequential statements (namesAndRoles below):
// Prisma loads several relations of one select concurrently, and inside an interactive
// transaction that means overlapping statements on one connection, which §3.3 forbids.
const RECORD_SELECT = {
  id: true,
  staffId: true,
  guardianId: true,
  status: true,
  email: true,
  emailVerifiedAt: true,
  passwordIsDefault: true,
  lastLoginAt: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

type RecordRow = Prisma.UserGetPayload<{ select: typeof RECORD_SELECT }>;

const liveSystemRoles = (roles: readonly { systemRole: SystemRole | null }[]): SystemRole[] =>
  roles.flatMap((r) => (r.systemRole === null ? [] : [r.systemRole]));

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * ORDER BY for a users page. `display_name` is the name the list shows, staff before guardian,
 * so a mixed page sorts as it reads; Prisma's relation orderBy cannot express the COALESCE,
 * hence the raw page query in list(). Fixed fragments only: nothing from the request is spliced.
 */
function orderBy(sort: UserSort): Prisma.Sql {
  switch (sort) {
    case 'fullName':
      return Prisma.sql`display_name ASC NULLS LAST`;
    case '-fullName':
      return Prisma.sql`display_name DESC NULLS LAST`;
    case 'lastLoginAt':
      return Prisma.sql`u.last_login_at ASC NULLS LAST`;
    case '-lastLoginAt':
      return Prisma.sql`u.last_login_at DESC NULLS LAST`;
    case 'createdAt':
      return Prisma.sql`u.created_at ASC`;
    case '-createdAt':
      return Prisma.sql`u.created_at DESC`;
  }
}

/** The filters of a users page as SQL predicates on `u`, `s` (staff) and `g` (guardians). */
function listFilters(query: UserListQuery): Prisma.Sql[] {
  const and: Prisma.Sql[] = [];
  if (query.status !== undefined) and.push(Prisma.sql`u.status::text = ${query.status}`);
  if (query.passwordIsDefault !== undefined)
    and.push(Prisma.sql`u.password_is_default = ${query.passwordIsDefault}`);
  if (query.hasEmail !== undefined)
    and.push(query.hasEmail ? Prisma.sql`u.email IS NOT NULL` : Prisma.sql`u.email IS NULL`);
  if (query.kind === 'staff') and.push(Prisma.sql`u.staff_id IS NOT NULL`);
  if (query.kind === 'guardian') and.push(Prisma.sql`u.guardian_id IS NOT NULL`);
  // Students have no login column until slice 6: the filter matches nothing.
  if (query.kind === 'student') and.push(Prisma.sql`false`);
  if (query.q !== undefined) {
    const pattern = `%${escapeLike(query.q)}%`;
    and.push(Prisma.sql`(s.full_name ILIKE ${pattern} OR g.full_name ILIKE ${pattern})`);
  }
  return and;
}

/** users (tenant). Every method takes the SchoolId first and joins the ambient transaction. */
@Injectable()
export class UserRepository {
  constructor(private readonly txHost: TransactionHost<PrismaTxAdapter>) {}

  async findAccess(schoolId: SchoolId, id: bigint): Promise<UserAccessRow | null> {
    const row = await this.txHost.tx.user.findFirst({
      where: { schoolId, id },
      select: { id: true, status: true, staffId: true, guardianId: true },
    });
    if (!row) return null;
    const staff =
      row.staffId === null
        ? null
        : await this.txHost.tx.staff.findFirst({
            where: { schoolId, id: row.staffId },
            select: { status: true },
          });
    const roles = await this.txHost.tx.userRole.findMany({
      where: { schoolId, userId: row.id, endedAt: null },
      select: { systemRole: true },
      orderBy: { id: 'asc' },
    });
    return { ...row, staffStatus: staff?.status ?? null, systemRoles: liveSystemRoles(roles) };
  }

  findCredentialsByUsernameHash(
    schoolId: SchoolId,
    usernameHash: string,
  ): Promise<UserCredentialRow | null> {
    return this.txHost.tx.user.findFirst({
      where: { schoolId, usernameHash },
      select: CREDENTIAL_SELECT,
    });
  }

  findCredentials(schoolId: SchoolId, id: bigint): Promise<UserCredentialRow | null> {
    return this.txHost.tx.user.findFirst({ where: { schoolId, id }, select: CREDENTIAL_SELECT });
  }

  /**
   * Locks the user row for the rest of the transaction and returns it as read under the lock
   * (§3.3, R99). An UPDATE holds its row lock until commit, so touching updated_at is a
   * SELECT ... FOR UPDATE that needs no raw SQL. Null if absent.
   */
  async lock(schoolId: SchoolId, id: bigint): Promise<UserCredentialRow | null> {
    const { count } = await this.txHost.tx.user.updateMany({
      where: { schoolId, id },
      data: { updatedAt: new Date() },
    });
    return count === 0 ? null : this.findCredentials(schoolId, id);
  }

  async find(schoolId: SchoolId, id: bigint): Promise<UserRecord | null> {
    const row = await this.txHost.tx.user.findFirst({
      where: { schoolId, id },
      select: RECORD_SELECT,
    });
    return row ? ((await this.withNamesAndRoles(schoolId, [row]))[0] ?? null) : null;
  }

  /**
   * A page of users. Raw SQL (listed in RAW_SQL_FILES, isolation-tested in
   * test/school-auth/repositories.e2e-spec.ts) because the default sort is the displayed name,
   * COALESCE(staff, guardian), which Prisma cannot order by. Every join and the WHERE carry the
   * school; the page's rows are then read through the scoped client.
   */
  async list(schoolId: SchoolId, query: UserListQuery): Promise<{ rows: UserRecord[]; total: number }> {
    const from = Prisma.sql`
      FROM users u
      LEFT JOIN staff s ON s.school_id = u.school_id AND s.id = u.staff_id
      LEFT JOIN guardians g ON g.school_id = u.school_id AND g.id = u.guardian_id
     WHERE ${Prisma.join([Prisma.sql`u.school_id = ${schoolId}`, ...listFilters(query)], ' AND ')}`;
    // Sequential, not Promise.all (§3.3).
    const page = await this.txHost.tx.$queryRaw<{ id: bigint }[]>`
      SELECT u.id, COALESCE(s.full_name, g.full_name) AS display_name
      ${from}
      ORDER BY ${orderBy(query.sort)}, u.id ASC
      LIMIT ${query.take} OFFSET ${query.skip}`;
    const counted = await this.txHost.tx.$queryRaw<{ total: number }[]>`
      SELECT count(*)::int AS total ${from}`;
    const ids = page.map((row) => row.id);
    const found =
      ids.length === 0
        ? []
        : await this.txHost.tx.user.findMany({
            where: { schoolId, id: { in: ids } },
            select: RECORD_SELECT,
          });
    const byId = new Map(found.map((row) => [row.id, row]));
    const rows = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    return { rows: await this.withNamesAndRoles(schoolId, rows), total: counted[0]?.total ?? 0 };
  }

  /**
   * Full names (staff, else guardian) and live system roles for a page of users: three
   * sequential statements, whatever the page size.
   */
  private async withNamesAndRoles(schoolId: SchoolId, rows: RecordRow[]): Promise<UserRecord[]> {
    const ids = (pick: (row: RecordRow) => bigint | null) =>
      rows.flatMap((row) => {
        const id = pick(row);
        return id === null ? [] : [id];
      });
    const staffIds = ids((row) => row.staffId);
    const guardianIds = ids((row) => row.guardianId);
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
    const roles = await this.txHost.tx.userRole.findMany({
      where: { schoolId, userId: { in: rows.map((row) => row.id) }, endedAt: null },
      select: { userId: true, systemRole: true },
      orderBy: { id: 'asc' },
    });
    const staffNames = new Map(staff.map((r) => [r.id, r.fullName]));
    const guardianNames = new Map(guardians.map((r) => [r.id, r.fullName]));
    return rows.map((row) => ({
      ...row,
      fullName:
        (row.staffId === null ? undefined : staffNames.get(row.staffId)) ??
        (row.guardianId === null ? undefined : guardianNames.get(row.guardianId)) ??
        '',
      systemRoles: liveSystemRoles(roles.filter((r) => r.userId === row.id)),
    }));
  }

  async create(
    schoolId: SchoolId,
    data: { usernameHash: string; passwordHash: string; staffId: bigint },
  ): Promise<bigint> {
    const row = await this.txHost.tx.user.create({
      data: {
        schoolId,
        usernameHash: data.usernameHash,
        passwordHash: data.passwordHash,
        passwordIsDefault: true,
        status: 'active',
        staffId: data.staffId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async linkStaff(schoolId: SchoolId, id: bigint, staffId: bigint): Promise<void> {
    await this.txHost.tx.user.update({
      where: { schoolId_id: { schoolId, id } },
      data: { staffId },
      select: { id: true },
    });
  }

  async recordLogin(schoolId: SchoolId, id: bigint, now: Date): Promise<void> {
    await this.txHost.tx.user.update({
      where: { schoolId_id: { schoolId, id } },
      data: { lastLoginAt: now },
      select: { id: true },
    });
  }

  /** A password the user chose (change or token reset). */
  async setChosenPassword(schoolId: SchoolId, id: bigint, passwordHash: string, now: Date): Promise<void> {
    await this.txHost.tx.user.update({
      where: { schoolId_id: { schoolId, id } },
      data: { passwordHash, passwordIsDefault: false, passwordChangedAt: now },
      select: { id: true },
    });
  }

  /** Office reset to the default password (contract §5.4); optionally clears the email. */
  async setDefaultPassword(
    schoolId: SchoolId,
    id: bigint,
    passwordHash: string,
    now: Date,
    clearEmail: boolean,
  ): Promise<void> {
    await this.txHost.tx.user.update({
      where: { schoolId_id: { schoolId, id } },
      data: {
        passwordHash,
        passwordIsDefault: true,
        officeResetAt: now,
        ...(clearEmail ? { email: null, emailVerifiedAt: null } : {}),
      },
      select: { id: true },
    });
  }

  /** A new address is unverified (R7). */
  async setEmail(schoolId: SchoolId, id: bigint, email: string): Promise<void> {
    await this.txHost.tx.user.update({
      where: { schoolId_id: { schoolId, id } },
      data: { email, emailVerifiedAt: null },
      select: { id: true },
    });
  }

  async markEmailVerified(schoolId: SchoolId, id: bigint, now: Date): Promise<void> {
    await this.txHost.tx.user.update({
      where: { schoolId_id: { schoolId, id } },
      data: { emailVerifiedAt: now },
      select: { id: true },
    });
  }

  /**
   * The encrypted identity number of the person behind the login, by priority staff CNIC, then
   * guardian CNIC (students arrive in slice 6). AAD is `schoolId|<table>|cnic` (plan §3.6).
   */
  async findIdentityCiphertext(
    schoolId: SchoolId,
    id: bigint,
  ): Promise<{ ciphertext: string; table: 'staff' | 'guardians' } | null> {
    const row = await this.txHost.tx.user.findFirst({
      where: { schoolId, id },
      select: { staffId: true, guardianId: true },
    });
    if (row && row.staffId !== null) {
      const staff = await this.txHost.tx.staff.findFirst({
        where: { schoolId, id: row.staffId },
        select: { cnic: true },
      });
      if (staff?.cnic) return { ciphertext: staff.cnic, table: 'staff' };
    }
    if (row && row.guardianId !== null) {
      const guardian = await this.txHost.tx.guardian.findFirst({
        where: { schoolId, id: row.guardianId },
        select: { cnic: true },
      });
      if (guardian?.cnic) return { ciphertext: guardian.cnic, table: 'guardians' };
    }
    return null;
  }

  /** Written only by the disable and enable endpoints (R71). */
  async setStatus(schoolId: SchoolId, id: bigint, status: UserStatusValue): Promise<void> {
    await this.txHost.tx.user.update({
      where: { schoolId_id: { schoolId, id } },
      data: { status },
      select: { id: true },
    });
  }
}
