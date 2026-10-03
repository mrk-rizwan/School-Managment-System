import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@asms/shared';
import type { Request } from 'express';
import { newSessionToken } from '../../common/auth/platform-session';
import { SCHOOL_SESSION_LIMITS } from '../../common/auth/school-session';
import { ApiException } from '../../common/errors/api-exception';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { SessionRepository } from '../../repositories/session.repository';
import { UserRepository } from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { PermissionsService, type UserAccess } from '../access/permissions.service';
import type { MeDto } from './dto';

/** Who is asking, for the session row. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function metaOf(req: Request): RequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
  };
}

/** A freshly minted cookie session: the token goes only into the cookie, never into a body. */
export interface IssuedSession {
  token: string;
  expiresAt: Date;
  me: MeDto;
}

const authRequired = () => new ApiException(401, ErrorCode.AUTH_REQUIRED, 'Sign in to continue.');

/** Builds MeDto and mints school sessions; shared by login, /me and the password flows. */
@Injectable()
export class MeService {
  constructor(
    private readonly users: UserRepository,
    private readonly ownSchool: OwnSchoolRepository,
    private readonly sessions: SessionRepository,
    private readonly permissions: PermissionsService,
  ) {}

  async build(
    schoolId: SchoolId,
    userId: bigint,
    access: UserAccess,
    sessionExpiresAt: Date,
  ): Promise<MeDto> {
    const user = await this.users.find(schoolId, userId);
    const school = await this.ownSchool.find(schoolId);
    if (!user || !school) throw authRequired();
    return {
      id: user.id.toString(),
      fullName: user.fullName,
      email: user.email,
      hasVerifiedEmail: user.emailVerifiedAt !== null,
      passwordIsDefault: user.passwordIsDefault,
      school: {
        id: school.id.toString(),
        name: school.name,
        shortCode: school.shortCode,
        status: school.status,
      },
      roles: this.permissions.roles(access),
      capabilities: this.permissions.sortedCapabilities(access),
      sessionExpiresAt,
    };
  }

  /**
   * A new cookie session (slice 2 mints cookie sessions only). `expiresAt` defaults to the
   * absolute lifetime from `now`; a rotation passes the old session's, so changing the password
   * never extends a sign-in.
   */
  async mint(
    schoolId: SchoolId,
    userId: bigint,
    meta: RequestMeta,
    now: Date,
    expiresAt: Date = new Date(now.getTime() + SCHOOL_SESSION_LIMITS.absoluteMs),
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, tokenHash } = newSessionToken();
    const row = await this.sessions.create(schoolId, {
      userId,
      tokenHash,
      channel: 'cookie',
      createdAt: now,
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return { token, expiresAt: row.expiresAt };
  }
}
