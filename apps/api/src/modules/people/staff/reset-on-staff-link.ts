import type { AuditLogRepository } from '../../../repositories/audit-log.repository';
import type { SessionRepository } from '../../../repositories/session.repository';
import type { UserTokenRepository } from '../../../repositories/user-token.repository';
import type { UserRepository } from '../../../repositories/user.repository';
import type { SchoolId } from '../../../tenancy/school-id';

export interface StaffLinkResetRepositories {
  users: UserRepository;
  sessions: SessionRepository;
  tokens: UserTokenRepository;
  audit: AuditLogRepository;
}

export interface StaffLinkReset {
  /** argon2id of the default password (the 13 identity digits). */
  defaultHash: string;
  now: Date;
  /** Who links: a school user (staff issue-login) or the platform (principal issue). */
  actor: { actorUserId: bigint | null; actorPlatformUserId?: bigint };
  /** The system role the link gives; recorded as the audit row's capacity. */
  capacity: string;
}

/**
 * An existing login gaining a staff capacity returns to the state of a fresh one, so nobody who
 * knew or set its password, email or sessions beforehand keeps a way in (wave-A security fix 1,
 * contracts/slice-2.md §7, slice-4.md §3.6): every session revoked, every outstanding token
 * voided, the password back to the default digits, the email cleared. Call in the transaction
 * that links the login, with its user row locked.
 */
export async function resetOnStaffLink(
  repositories: StaffLinkResetRepositories,
  schoolId: SchoolId,
  userId: bigint,
  { defaultHash, now, actor, capacity }: StaffLinkReset,
): Promise<void> {
  const { users, sessions, tokens, audit } = repositories;
  await users.setDefaultPassword(schoolId, userId, defaultHash, now, true);
  await sessions.revokeAllForUser(schoolId, userId, now);
  await tokens.voidOutstanding(schoolId, userId, now);
  await audit.record(schoolId, {
    ...actor,
    action: 'user.reset_on_staff_link',
    subjectType: 'user',
    subjectId: userId,
    metadata: { capacity },
  });
}
