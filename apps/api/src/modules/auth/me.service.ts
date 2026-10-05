import { Injectable } from '@nestjs/common';
import { CAPACITIES, ErrorCode, type Capacity } from '@asms/shared';
import type { Request } from 'express';
import { newSessionToken } from '../../common/auth/platform-session';
import { sessionLifetime, type SessionChannelName } from '../../common/auth/school-session';
import { ApiException } from '../../common/errors/api-exception';
import { SchoolClock } from '../../common/school-clock';
import { ClassRepository } from '../../repositories/class.repository';
import { EnrolmentRepository } from '../../repositories/enrolment.repository';
import { OwnSchoolRepository } from '../../repositories/own-school.repository';
import { SessionRepository } from '../../repositories/session.repository';
import {
  isActiveOn,
  TeacherAssignmentRepository,
} from '../../repositories/teacher-assignment.repository';
import { UserRepository } from '../../repositories/user.repository';
import type { SchoolId } from '../../tenancy/school-id';
import { toDateString } from '../academics/academics.shared';
import { capabilityOrder } from '../access/effective-permissions';
import { PermissionsService, type UserAccess } from '../access/permissions.service';
import type { LoginResultDto, MeAssignmentDto, MeDto, MyChildDto } from './dto';

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

/**
 * A freshly minted session. A cookie session's token goes only into the cookie; a bearer
 * session's only into `LoginResultDto.bearerToken` (R153).
 */
export interface IssuedSession {
  token: string;
  channel: SessionChannelName;
  expiresAt: Date;
  me: MeDto;
}

/** The response body for an issued session: the token in the body only for bearer (R153). */
export const loginResult = (issued: IssuedSession): LoginResultDto => ({
  ...issued.me,
  bearerToken: issued.channel === 'bearer' ? issued.token : null,
});

const authRequired = () => new ApiException(401, ErrorCode.AUTH_REQUIRED, 'Sign in to continue.');

const byName = (a: string | null, b: string | null): number => (a ?? '').localeCompare(b ?? '');

/** Builds MeDto and mints school sessions; shared by login, /me and the password flows. */
@Injectable()
export class MeService {
  constructor(
    private readonly users: UserRepository,
    private readonly ownSchool: OwnSchoolRepository,
    private readonly sessions: SessionRepository,
    private readonly permissions: PermissionsService,
    private readonly assignments: TeacherAssignmentRepository,
    private readonly classes: ClassRepository,
    private readonly enrolments: EnrolmentRepository,
    private readonly clock: SchoolClock,
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
      // §8: from the lines already computed for this request (no new query), in the same order.
      capabilityScopes: [...access.lines]
        .filter((line) => access.capabilities.has(line.capability))
        .sort((a, b) => capabilityOrder(a.capability, b.capability))
        .map((line) => ({ capability: line.capability, scope: line.scope })),
      // Rule 24 (R225): held through a role or grant, inert until the password is changed.
      blockedCapabilities: [...access.blockedCapabilities],
      sessionExpiresAt,
      capacities: CAPACITIES.filter((capacity: Capacity) => access.capacities[capacity]),
      assignments: await this.assignmentsOf(schoolId, access),
      staffId: access.staffId?.toString() ?? null,
      children: await this.childrenOf(schoolId, access),
    };
  }

  /**
   * The guardian scope's children (contracts/slice-13.md §1.2, R163) with their active enrolment,
   * by name; [] without guardian capacity. An ended link drops the child on the next call (R164).
   */
  private async childrenOf(schoolId: SchoolId, access: UserAccess): Promise<MyChildDto[]> {
    const { scope, children } = await this.permissions.guardianChildren(schoolId, access);
    if (children.length === 0) return [];
    const active = await this.enrolments.activeForStudents(
      schoolId,
      scope,
      children.map((c) => c.studentId),
    );
    const current = new Map(active.map((row) => [row.studentId, row]));
    return children.map((child): MyChildDto => {
      const row = current.get(child.studentId);
      return {
        studentId: child.studentId.toString(),
        fullName: child.fullName,
        status: child.status,
        relationship: child.relationship,
        current: row
          ? {
              enrolmentId: row.id.toString(),
              academicYearId: row.academicYearId.toString(),
              academicYearName: row.academicYearName,
              classId: row.classId.toString(),
              className: row.className,
              sectionId: row.sectionId.toString(),
              sectionName: row.sectionName,
              rollNo: row.rollNo,
            }
          : null,
      };
    });
  }

  /**
   * The caller's teacher assignments active today on the school's clock, cover included, sorted
   * by class, section and subject name; [] without staff capacity (contracts/slice-9.md §2.2).
   */
  private async assignmentsOf(schoolId: SchoolId, access: UserAccess): Promise<MeAssignmentDto[]> {
    if (!access.capacities.staff || access.staffId === null) return [];
    const today = await this.clock.today(schoolId);
    const rows = (await this.assignments.findNotEndedForStaff(schoolId, access.staffId, today)).filter(
      (row) => isActiveOn(row, today),
    );
    // Sequential reads (no Promise.all on one connection); a teacher has a handful of classes.
    const modes = new Map<bigint, MeAssignmentDto['attendanceMode']>();
    for (const classId of new Set(rows.map((row) => row.classId))) {
      const klass = await this.classes.findById(schoolId, classId);
      if (klass) modes.set(classId, klass.attendanceMode);
    }
    return rows
      .map(
        (row): MeAssignmentDto => ({
          id: row.id.toString(),
          role: row.role,
          academicYearId: row.academicYearId.toString(),
          classId: row.classId.toString(),
          className: row.className,
          sectionId: row.sectionId?.toString() ?? null,
          sectionName: row.sectionName,
          subjectId: row.subjectId?.toString() ?? null,
          subjectName: row.subjectName,
          attendanceMode: modes.get(row.classId) ?? 'daily',
          startsOn: toDateString(row.startsOn),
          endsOn: row.endsOn === null ? null : toDateString(row.endsOn),
        }),
      )
      .sort(
        (a, b) =>
          byName(a.className, b.className) ||
          byName(a.sectionName, b.sectionName) ||
          byName(a.subjectName, b.subjectName) ||
          (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
      );
  }

  /**
   * A new session on `channel` (contracts/slice-9.md §1.5). `expiresAt` defaults to the absolute
   * lifetime of the channel and the capacities held now (a teacher-parent gets the staff values);
   * a rotation passes the old session's, so changing the password never extends a sign-in.
   */
  async mint(
    schoolId: SchoolId,
    userId: bigint,
    channel: SessionChannelName,
    capacities: UserAccess['capacities'],
    meta: RequestMeta,
    now: Date,
    expiresAt: Date = new Date(now.getTime() + sessionLifetime(channel, capacities).absoluteMs),
  ): Promise<{ id: bigint; token: string; expiresAt: Date }> {
    const { token, tokenHash } = newSessionToken();
    const row = await this.sessions.create(schoolId, {
      userId,
      tokenHash,
      channel,
      createdAt: now,
      expiresAt,
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return { id: row.id, token, expiresAt: row.expiresAt };
  }
}
