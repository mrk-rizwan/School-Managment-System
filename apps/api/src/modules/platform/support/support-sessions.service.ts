import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import { ErrorCode, type SupportSessionEnd } from '@asms/shared';
import { ApiException, notFound } from '../../../common/errors/api-exception';
import { toPage, type Page, type PageQueryDto } from '../../../common/pagination';
import { NotificationService } from '../../../messaging/notification.service';
import {
  SupportSessionRepository,
  type BrandedSupportSession,
  type ExpiredSupportSession,
  type SupportSessionRow,
  type SupportSessionView,
} from '../../../repositories/platform/support-session.repository';
import type { SchoolId } from '../../../tenancy/school-id';
import {
  schoolIdFromExpiredSupportSession,
  schoolIdFromSupportSession,
} from '../../../tenancy/school-id.mint';
import type {
  ListSupportSessionsQueryDto,
  MeSupportSessionDto,
  OpenSupportSessionDto,
  SchoolSupportSessionDto,
  SupportSessionDto,
  SupportSessionStatus,
} from './support.dto';

// Phase 5 slice 45 (contracts/slice-45.md §2.1, §2.3-§2.5; rule 35, R349, R352): opening, closing,
// revoking and expiring platform support sessions. None of these runs with the `support` flag:
// they are the platform's own bookkeeping, and each writes both audit logs (the exception-1
// principal-login precedent) and, where the session's state changes, a notice to the principals.

/** The job name in the expiry's audit metadata (audit_log_actor_check reads the platform actor). */
export const SUPPORT_EXPIRE_JOB = 'support-session-expire';

const NOTICE_STAGE = { opened: 1n, closed: 2n } as const;

/**
 * `messages.subject_id` of a support notice: `sessionId * 10 + stage`. messages is unique per person
 * per subject whatever the type (R107), so the opened and closed notices of one session are two
 * subjects (the contract-warning precedent, contract-expiry.job.ts).
 */
export const supportNoticeSubjectId = (sessionId: bigint, stage: keyof typeof NOTICE_STAGE): bigint =>
  sessionId * 10n + NOTICE_STAGE[stage];

/** 403 SUPPORT_SESSION_ENDED with how it ended (R352). */
export const sessionEnded = (reason: SupportSessionEnd): ApiException =>
  new ApiException(403, ErrorCode.SUPPORT_SESSION_ENDED, 'The support session has ended.', { reason });

/** How a row ended, or null while it is open at `now`. A row past its time is `expired`. */
export function endOf(row: SupportSessionRow, now: Date): SupportSessionEnd | null {
  if (row.endKind !== null) return row.endKind;
  return row.expiresAt.getTime() <= now.getTime() ? 'expired' : null;
}

const statusOf = (row: SupportSessionRow, now: Date): SupportSessionStatus =>
  endOf(row, now) === null ? 'open' : 'ended';

export function toSupportSessionDto(row: SupportSessionView, platformUserId: bigint, now: Date): SupportSessionDto {
  return {
    id: row.id.toString(),
    schoolId: row.schoolId.toString(),
    schoolName: row.schoolName,
    platformUserId: row.platformUserId.toString(),
    platformUserEmail: row.platformUserEmail,
    mine: row.platformUserId === platformUserId,
    reason: row.reason,
    ticketRef: row.ticketRef,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
    status: statusOf(row, now),
    closedAt: row.closedAt,
    endKind: endOf(row, now),
    closeReason: row.closeReason,
    revokeReason: row.revokeReason,
  };
}

function toSchoolDto(row: SupportSessionView, now: Date): SchoolSupportSessionDto {
  return {
    id: row.id.toString(),
    supportName: row.platformUserEmail,
    reason: row.reason,
    ticketRef: row.ticketRef,
    openedAt: row.openedAt,
    expiresAt: row.expiresAt,
    status: statusOf(row, now),
    closedAt: row.closedAt,
    endKind: endOf(row, now),
    revokeReason: row.revokeReason,
  };
}

const HOUR_MS = 60 * 60_000;

@Injectable()
export class SupportSessionsService {
  constructor(
    private readonly sessions: SupportSessionRepository,
    private readonly notifications: NotificationService,
  ) {}

  // ------------------------------------------------------------------ platform side

  /**
   * §2.1 step 2 (the TOTP has been verified and its step stored by the caller). Expires the stale
   * rows the database would otherwise count, then refuses an open school or a fourth session.
   */
  @Transactional()
  async open(
    platformUserId: bigint,
    schoolRowId: bigint,
    dto: OpenSupportSessionDto,
    now: Date = new Date(),
  ): Promise<SupportSessionDto> {
    const school = await this.sessions.findSchool(schoolRowId);
    if (school === null) throw notFound();
    if (school.status === 'terminated') {
      throw new ApiException(409, ErrorCode.SCHOOL_TERMINATED, 'A terminated school cannot be changed.');
    }
    for (const stale of await this.sessions.expireDue({ platformUserId, schoolId: school.id }, now)) {
      await this.recordExpired(stale, { via: 'open' });
    }
    const open = await this.sessions.findOpenForSchoolRow(school.id, now);
    if (open !== null) {
      throw new ApiException(409, ErrorCode.SUPPORT_SESSION_OPEN, 'The school already has an open support session.', {
        sessionId: open.id.toString(),
      });
    }
    if ((await this.sessions.countOpenOwned(platformUserId, now)) >= 3) {
      throw new ApiException(409, ErrorCode.SUPPORT_SESSION_LIMIT, 'You already have three open support sessions.');
    }
    const hours = await this.sessions.sessionHours();
    const row = await this.sessions.insertOpen({
      platformUserId,
      schoolId: school.id,
      reason: dto.reason,
      ticketRef: dto.ticketRef,
      openedAt: now,
      expiresAt: new Date(now.getTime() + hours * HOUR_MS),
    });
    const schoolId = schoolIdFromSupportSession(row);
    const [view] = await this.sessions.withNames([row]);
    const supportName = view?.platformUserEmail ?? '';
    const notified = await this.notify(schoolId, row.id, 'opened', {
      type: 'support_session_opened',
      vars: { supportName, reason: row.reason, expiresAt: row.expiresAt },
    });
    await this.sessions.recordBoth(schoolId, {
      platformUserId,
      action: 'support_session.opened',
      sessionId: row.id,
      reason: row.reason,
      metadata: { ticketRef: row.ticketRef, expiresAt: row.expiresAt.toISOString(), principalsNotified: notified },
    });
    if (view === undefined) throw notFound();
    return toSupportSessionDto(view, platformUserId, now);
  }

  async list(platformUserId: bigint, query: ListSupportSessionsQueryDto): Promise<Page<SupportSessionDto>> {
    const now = new Date();
    const { rows, total } = await this.sessions.list(
      {
        ...(query.schoolId === undefined ? {} : { schoolId: BigInt(query.schoolId) }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      now,
      (query.page - 1) * query.limit,
      query.limit,
    );
    return toPage(
      rows.map((row) => toSupportSessionDto(row, platformUserId, now)),
      query,
      total,
    );
  }

  async get(platformUserId: bigint, id: bigint): Promise<SupportSessionDto> {
    const row = await this.sessions.find(id);
    if (row === null) throw notFound();
    const [view] = await this.sessions.withNames([row]);
    if (view === undefined) throw notFound();
    return toSupportSessionDto(view, platformUserId, new Date());
  }

  /**
   * The guard's check (R352): another admin's session, or an unknown id, is 404; one that has ended
   * (closed, revoked, past its time) is 403 with how.
   */
  async assertOpenOwned(platformUserId: bigint, id: bigint, now: Date = new Date()): Promise<void> {
    const row = await this.sessions.find(id);
    if (row === null || row.platformUserId !== platformUserId) throw notFound();
    const end = endOf(row, now);
    if (end !== null) throw sessionEnded(end);
  }

  /** The owner's close (§2.3). */
  @Transactional()
  async close(platformUserId: bigint, id: bigint, reason: string | undefined): Promise<SupportSessionDto> {
    const now = new Date();
    const row = await this.sessions.findOpenOwned(id, platformUserId, now);
    if (row === null) {
      await this.assertOpenOwned(platformUserId, id, now);
      throw notFound();
    }
    if (!(await this.closeOne(row, now, reason ?? null, {}))) {
      // A lost race (a revoke, an expiry or a second close ended it first): 403 with how, as revoke.
      const after = await this.sessions.find(id);
      throw sessionEnded((after && endOf(after, now)) ?? 'closed');
    }
    return this.get(platformUserId, id);
  }

  /** Platform logout (R349): every open session of the caller is closed, each in both logs. */
  @Transactional()
  async closeAllForUser(platformUserId: bigint): Promise<number> {
    const now = new Date();
    const rows = await this.sessions.findOpenOwnedAll(platformUserId, now);
    let closed = 0;
    for (const row of rows) closed += (await this.closeOne(row, now, null, { via: 'logout' })) ? 1 : 0;
    return closed;
  }

  // ------------------------------------------------------------------ school side

  async listForSchool(schoolId: SchoolId, query: PageQueryDto): Promise<Page<SchoolSupportSessionDto>> {
    const now = new Date();
    const { rows, total } = await this.sessions.listForSchool(schoolId, (query.page - 1) * query.limit, query.limit);
    return toPage(
      rows.map((row) => toSchoolDto(row, now)),
      query,
      total,
    );
  }

  /** MeDto.supportSession for a staff user: the school's open session, or null. */
  async currentForSchool(schoolId: SchoolId): Promise<MeSupportSessionDto | null> {
    const row = await this.sessions.openForSchool(schoolId, new Date());
    return row === null ? null : { id: row.id.toString(), reason: row.reason, expiresAt: row.expiresAt };
  }

  /** The school's revoke (§2.3, R349): any `school.settings.manage` holder, with a reason. */
  @Transactional()
  async revoke(schoolId: SchoolId, userId: bigint, id: bigint, reason: string): Promise<SchoolSupportSessionDto> {
    const now = new Date();
    const row = await this.sessions.findForSchool(schoolId, id);
    if (row === null) throw notFound();
    const end = endOf(row, now);
    if (end !== null) throw sessionEnded(end);
    if (!(await this.sessions.revoke(schoolId, id, userId, reason, now))) {
      const after = await this.sessions.findForSchool(schoolId, id);
      throw sessionEnded((after && endOf(after, now)) ?? 'closed');
    }
    const supportName = await this.supportNameOf(row);
    await this.notify(schoolId, row.id, 'closed', {
      type: 'support_session_closed',
      vars: { supportName, how: 'revoked' },
    });
    await this.sessions.recordBoth(schoolId, {
      platformUserId: row.platformUserId,
      actorUserId: userId,
      action: 'support_session.revoked',
      sessionId: row.id,
      reason,
      metadata: {},
    });
    const [view] = await this.sessions.withNames([{ ...row, closedAt: now, endKind: 'revoked', revokedAt: now, revokedBy: userId, revokeReason: reason }]);
    if (view === undefined) throw notFound();
    return toSchoolDto(view, now);
  }

  // ------------------------------------------------------------------ expiry (§2.4)

  /** The job's per-school body, inside runAsSchool with the fan-out's SchoolId. */
  @Transactional()
  async expireForSchool(schoolId: SchoolId, now: Date = new Date()): Promise<number> {
    const expired = await this.sessions.expireDue({ schoolId }, now);
    for (const row of expired) await this.recordExpired(row, { job: SUPPORT_EXPIRE_JOB }, schoolId);
    return expired.length;
  }

  // ------------------------------------------------------------------ internals

  /** Closes one open, owned row; false when a race ended it first (nothing written). */
  private async closeOne(
    row: BrandedSupportSession,
    now: Date,
    reason: string | null,
    metadata: Record<string, string>,
  ): Promise<boolean> {
    if (!(await this.sessions.close(row.id, row.platformUserId, now, reason))) return false;
    const schoolId = schoolIdFromSupportSession(row);
    const supportName = await this.supportNameOf(row);
    await this.notify(schoolId, row.id, 'closed', {
      type: 'support_session_closed',
      vars: { supportName, how: 'closed' },
    });
    await this.sessions.recordBoth(schoolId, {
      platformUserId: row.platformUserId,
      action: 'support_session.closed',
      sessionId: row.id,
      ...(reason === null ? {} : { reason }),
      metadata,
    });
    return true;
  }

  /**
   * Both logs and the notice for a row the repository has just closed as expired: its school comes
   * from the expired brand, which no support read accepts (contracts/slice-45.md §4).
   */
  private async recordExpired(
    row: ExpiredSupportSession,
    metadata: Record<string, string>,
    schoolId: SchoolId = schoolIdFromExpiredSupportSession(row),
  ): Promise<void> {
    const supportName = await this.supportNameOf(row);
    await this.notify(schoolId, row.id, 'closed', {
      type: 'support_session_closed',
      vars: { supportName, how: 'expired' },
    });
    await this.sessions.recordBoth(schoolId, {
      platformUserId: row.platformUserId,
      action: 'support_session.expired',
      sessionId: row.id,
      metadata: { ...metadata, expiresAt: row.expiresAt.toISOString() },
    });
  }

  private async supportNameOf(row: SupportSessionRow): Promise<string> {
    const [view] = await this.sessions.withNames([row]);
    return view?.platformUserEmail ?? '';
  }

  /** The notice to every active principal; the number told (0: platform log only, §3.4). */
  private async notify(
    schoolId: SchoolId,
    sessionId: bigint,
    stage: keyof typeof NOTICE_STAGE,
    message:
      | { type: 'support_session_opened'; vars: { supportName: string; reason: string; expiresAt: Date } }
      | { type: 'support_session_closed'; vars: { supportName: string; how: 'expired' | 'closed' | 'revoked' } },
  ): Promise<number> {
    const principals = await this.sessions.principalStaffIds(schoolId);
    if (principals.length === 0) return 0;
    const subject = { type: 'support_session' as const, id: supportNoticeSubjectId(sessionId, stage) };
    const recipients = principals.map((staffId) => ({ staffId }));
    if (message.type === 'support_session_opened') {
      await this.notifications.send(schoolId, { type: message.type, subject, recipients, vars: message.vars });
    } else {
      await this.notifications.send(schoolId, { type: message.type, subject, recipients, vars: message.vars });
    }
    return principals.length;
  }
}
