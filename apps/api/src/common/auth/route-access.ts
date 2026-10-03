import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode, type Capability } from '@asms/shared';
import type { Request } from 'express';
import { ApiException } from '../errors/api-exception';
// The one import from src/common into a feature module: resolving a platform session needs the
// platform repositories, which only src/modules/platform may use. PlatformAuthModule is global
// and exports it, so the guard receives it by injection.
import { PlatformSessionAccess } from '../../modules/platform/auth/platform-session-access';
// School routes: session resolution lives in src/tenancy (named exception 4) and the
// capability check in src/modules/access; both are global providers.
import { PermissionsService } from '../../modules/access/permissions.service';
import { SchoolSessionResolver } from '../../tenancy/school-session-resolver';
import { bindRequestScope } from './school-session';

// Every route declares who may call it. Exactly one of these seven, on the handler or its
// controller (contracts/slice-2.md §1, contracts/slice-9.md §1.1, plan §4.3).
const PUBLIC = 'access:public';
const AUTHENTICATED_ONLY = 'access:authenticated-only';
const CAPABILITY = 'access:capability';
const PLATFORM_SESSION = 'access:platform-session';
const STAFF = 'access:staff';
const CAPACITY = 'access:capacity';
const WEBHOOK = 'access:webhook';

export const ROUTE_ACCESS_KEYS = {
  PUBLIC,
  AUTHENTICATED_ONLY,
  CAPABILITY,
  PLATFORM_SESSION,
  STAFF,
  CAPACITY,
  WEBHOOK,
} as const;

/** No session needed (health, login, password reset). Listed in the R68 route snapshot. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

/** Any signed-in user, no capability (me, logout). Listed in the R68 route snapshot. */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY, true);

/** The caller must hold ANY of the listed capabilities (contracts/slice-2.md §1). */
export const RequireCapability = (
  ...capabilities: [Capability, ...Capability[]]
): MethodDecorator & ClassDecorator => SetMetadata(CAPABILITY, capabilities);

/**
 * Any signed-in user with an active staff capacity, no capability needed (staff-wide reads such
 * as the academic structure). Parent and student sessions are refused (R78).
 */
export const RequireStaff = (): MethodDecorator & ClassDecorator => SetMetadata(STAFF, true);

/** The non-staff capacities a route can demand (plan §4.3). There is no 'any': that is @AuthenticatedOnly. */
export type RouteCapacity = 'guardian' | 'student';

/**
 * Guardian- or student-only routes (plan §4.3, R163). The caller's session must hold that
 * capacity; guardians and students hold no capabilities (rule 13), so this is their only gate.
 * Such routes live under /me/children/* (guardian) and /me/student/* (student) — the R68
 * snapshot asserts every @RequireCapacity route is under /me/.
 */
export const RequireCapacity = (capacity: RouteCapacity): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPACITY, capacity);

/** Providers that call us back (contracts/slice-9.md §8.1). */
export type WebhookProvider = 'waha' | 'meta';

/**
 * Provider callbacks under /webhooks (contracts/slice-9.md §8.1, R172). Metadata only for this
 * guard: no session is resolved; the signature is verified by the webhook module's own guard.
 */
export const Webhook = (provider: WebhookProvider): MethodDecorator & ClassDecorator =>
  SetMetadata(WEBHOOK, provider);

/**
 * Platform-admin routes (/api/v1/platform). The level says which platform sessions may call it
 * (contracts/slice-1.md): 'full' needs an enrolled authenticator and a changed password;
 * 'password-change' allows a full-stage session that must still change its password; 'any'
 * also allows the TOTP-enrolment stage. Platform sessions are never accepted on school routes
 * and school sessions never here (R56).
 */
export type PlatformSessionLevel = 'full' | 'password-change' | 'any';
export const PlatformSession = (level: PlatformSessionLevel = 'full'): MethodDecorator & ClassDecorator =>
  SetMetadata(PLATFORM_SESSION, level);

const permissionDenied = () =>
  new ApiException(403, ErrorCode.PERMISSION_DENIED, 'You do not have permission to do this.');

const ALL_KEYS = [PUBLIC, AUTHENTICATED_ONLY, CAPABILITY, PLATFORM_SESSION, STAFF, CAPACITY, WEBHOOK];

/**
 * Every route declares exactly one of the seven decorators; none, or more than one, fails closed
 * (500, logged) instead of shipping an open or ambiguous endpoint.
 *
 * Each declaration selects one resolver and only that one runs: @PlatformSession resolves the
 * platform cookie against platform_sessions and nothing else. The school branch
 * (@AuthenticatedOnly, @RequireStaff, @RequireCapability, @RequireCapacity) reads only the school
 * cookie or bearer, so neither kind of session can ever satisfy the other's routes (R56).
 *
 * A parent-only or student-only session has no staff capacity and no capability, so it is
 * refused 403 on every @RequireStaff and @RequireCapability route; @AuthenticatedOnly and
 * @RequireCapacity are only on /auth/logout and /me/* (R78, enumerated by
 * test/core/routes.e2e-spec.ts).
 *
 * A suspended school works exactly like an active one (Phase 1 R80 lifted by contracts/slice-9.md
 * §10); only a terminated school's sessions are refused, by session resolution.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  private readonly logger = new Logger('RouteAccessGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly platformSessions: PlatformSessionAccess,
    private readonly schoolSessions: SchoolSessionResolver,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const read = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, targets);
    const declared = ALL_KEYS.filter((key) => read<unknown>(key) !== undefined);
    if (declared.length !== 1) {
      this.logger.error(
        { controller: context.getClass().name, handler: context.getHandler().name, declared },
        declared.length === 0 ? 'undecorated route' : 'route declares more than one access rule',
      );
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    const level = read<PlatformSessionLevel>(PLATFORM_SESSION);
    if (level !== undefined) {
      await this.platformSessions.authorise(context.switchToHttp().getRequest<Request>(), level);
    }
    if (read<unknown>(PUBLIC) !== undefined || level !== undefined) return true;
    // Verified by the webhook module's signature guard, which runs after this one.
    if (read<unknown>(WEBHOOK) !== undefined) return true;

    // School routes (contract slice-2 §1.1).
    const req = context.switchToHttp().getRequest<Request>();
    const session = await this.schoolSessions.resolve(req);
    if (read<unknown>(STAFF) !== undefined && !session.access.capacities.staff) {
      throw permissionDenied();
    }
    const capacity = read<RouteCapacity>(CAPACITY);
    if (capacity !== undefined && !session.access.capacities[capacity]) throw permissionDenied();
    const capabilities = read<readonly Capability[]>(CAPABILITY);
    if (capabilities !== undefined) {
      const scope = await this.permissions.canAny(session.schoolId, session.access, capabilities);
      if (scope === null) throw permissionDenied();
      // The row scope travels with the session: services read it with scopeOf(session) and pass
      // it to the repository, so a teacher admitted with no sections reads no rows (R79).
      bindRequestScope(req, scope);
    }
    return true;
  }
}
