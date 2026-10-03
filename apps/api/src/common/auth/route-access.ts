import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@asms/shared';
import type { Request } from 'express';
import { ApiException } from '../errors/api-exception';
// The one import from src/common into a feature module: resolving a platform session needs the
// platform repositories, which only src/modules/platform may use. PlatformAuthModule is global
// and exports it, so the guard receives it by injection.
import { PlatformSessionAccess } from '../../modules/platform/auth/platform-session-access';

// Every route declares who may call it. Exactly one of these four, on the handler or its
// controller. Slice 2 enforces sessions and capabilities behind the same metadata.
const PUBLIC = 'access:public';
const AUTHENTICATED_ONLY = 'access:authenticated-only';
const CAPABILITY = 'access:capability';
const PLATFORM_SESSION = 'access:platform-session';

/** No session needed (health, login, password reset). Listed in the R68 route snapshot. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

/** Any signed-in user, no capability (me, logout). Listed in the R68 route snapshot. */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY, true);

/** The capability the caller must hold. A string until slice 2 introduces the Capability enum. */
export const RequireCapability = (capability: string): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY, capability);

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

/**
 * Every route declares exactly one of the four decorators; none, or more than one, fails closed
 * (500, logged) instead of shipping an open or ambiguous endpoint.
 *
 * Each declaration selects one resolver and only that one runs: @PlatformSession resolves the
 * platform cookie against platform_sessions and nothing else. Slice 2 adds school session
 * resolution under the AUTHENTICATED_ONLY / CAPABILITY branch, which reads only the school
 * cookie or bearer, so neither kind of session can ever satisfy the other's routes (R56).
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  private readonly logger = new Logger('RouteAccessGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly platformSessions: PlatformSessionAccess,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const read = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, targets);
    const declared = [PUBLIC, AUTHENTICATED_ONLY, CAPABILITY, PLATFORM_SESSION].filter(
      (key) => read<unknown>(key) !== undefined,
    );
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
    return true;
  }
}
