import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ErrorCode } from '@asms/shared';
import { ApiException } from '../errors/api-exception';

// Every route declares who may call it. Exactly one of these three, on the handler or its
// controller. Slice 2 enforces sessions and capabilities behind the same metadata.
const PUBLIC = 'access:public';
const AUTHENTICATED_ONLY = 'access:authenticated-only';
const CAPABILITY = 'access:capability';

/** No session needed (health, login, password reset). Listed in the R68 route snapshot. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

/** Any signed-in user, no capability (me, logout). Listed in the R68 route snapshot. */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY, true);

/** The capability the caller must hold. A string until slice 2 introduces the Capability enum. */
export const RequireCapability = (capability: string): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY, capability);

/**
 * Refuses any route that declares none of the three decorators, so a forgotten decorator
 * fails closed (500, logged) instead of shipping an open endpoint. Today it enforces only
 * that a declaration exists; slice 2 adds session and capability checks here.
 */
@Injectable()
export class RouteAccessGuard implements CanActivate {
  private readonly logger = new Logger('RouteAccessGuard');

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const declared = [PUBLIC, AUTHENTICATED_ONLY, CAPABILITY].some(
      (key) => this.reflector.getAllAndOverride<unknown>(key, targets) !== undefined,
    );
    if (!declared) {
      this.logger.error(
        { controller: context.getClass().name, handler: context.getHandler().name },
        'undecorated route',
      );
      throw new ApiException(500, ErrorCode.INTERNAL_ERROR, 'Something went wrong.');
    }
    return true;
  }
}
