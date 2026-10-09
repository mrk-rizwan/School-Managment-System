// Phase 5 groundwork (phase-5-extended.md §1.1 "Rule 24 reach", §3.1, §5.1): the two access
// markers RouteAccessGuard gains. @DefaultPasswordInert(action) refuses a default-password caller
// after the route's access check (R355; slice 46 marks the routes); @DeviceToken() is an eighth,
// exclusive access rule resolved by the device-punch service (R348; slice 44 adds the route). The
// guard runs here with stand-ins for its four collaborators, so each branch is seen in isolation.
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { Request } from 'express';
import { Capability, ErrorCode } from '@asms/shared';
import {
  DefaultPasswordInert,
  DeviceToken,
  Public,
  RequireCapability,
  RequireStaff,
  RouteAccessGuard,
} from '../../src/common/auth/route-access';
import { bindSchoolSession, type SchoolSessionContext } from '../../src/common/auth/school-session';
import { ApiException } from '../../src/common/errors/api-exception';
import type { PermissionsService, UserAccess } from '../../src/modules/access/permissions.service';
import type { PlatformSessionAccess } from '../../src/modules/platform/auth/platform-session-access';
import type { DevicePunchService } from '../../src/modules/staff-attendance/device-punch.service';
import type { SchoolSessionResolver } from '../../src/tenancy/school-session-resolver';
import { studentsScope } from '../support/isolation';

class Routes {
  @RequireCapability(Capability.PAYMENT_VOID)
  @DefaultPasswordInert('payment.void')
  voidPayment(this: void): void {}

  @RequireCapability(Capability.PAYMENT_RECORD)
  recordPayment(this: void): void {}

  @RequireStaff()
  @DefaultPasswordInert('expense.payee_change')
  staffInert(this: void): void {}

  @Public()
  @DefaultPasswordInert('payment.refund')
  publicInert(this: void): void {}

  @DeviceToken()
  punch(this: void): void {}

  @DeviceToken()
  @RequireStaff()
  ambiguous(this: void): void {}
}

interface Calls {
  canAny: number;
  refusal: string[];
  device: number;
}

function setUp(options: { passwordIsDefault: boolean; holds: boolean }) {
  const calls: Calls = { canAny: 0, refusal: [], device: 0 };
  const access = { userId: 7n, capacities: { staff: true, guardian: false, student: false }, passwordIsDefault: options.passwordIsDefault } as UserAccess;
  const resolver = {
    resolve: (req: Request) => {
      const session = { schoolId: 1n, access } as SchoolSessionContext;
      bindSchoolSession(req, session);
      return Promise.resolve(session);
    },
  } as SchoolSessionResolver;
  const permissions: Pick<PermissionsService, 'canAny' | 'defaultPasswordRefusal' | 'defaultPasswordActionRefusal'> = {
    canAny: () => {
      calls.canAny += 1;
      return Promise.resolve(options.holds ? studentsScope([]) : null);
    },
    defaultPasswordRefusal: () => Promise.resolve(null),
    defaultPasswordActionRefusal: (_school: unknown, _access: unknown, action: string) => {
      calls.refusal.push(action);
      return Promise.resolve(new ApiException(403, ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION, 'Change your password first.'));
    },
  };
  const devices: Pick<DevicePunchService, 'authorise'> = {
    authorise: () => {
      calls.device += 1;
      return Promise.resolve();
    },
  };
  const guard = new RouteAccessGuard(
    new Reflector(),
    {} as PlatformSessionAccess,
    resolver,
    permissions as PermissionsService,
    devices as DevicePunchService,
  );
  const run = (handler: keyof Routes) => {
    const req = { headers: {} } as Request;
    return guard.canActivate(new ExecutionContextHost([req], Routes, Routes.prototype[handler]));
  };
  return { run, calls };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'passed';
  } catch (error) {
    return error instanceof ApiException ? `${error.status} ${error.code}` : 'other';
  }
};

describe('RouteAccessGuard: Phase 5 markers', () => {
  it('@DefaultPasswordInert refuses a default-password holder after the capability check, naming the action', async () => {
    const { run, calls } = setUp({ passwordIsDefault: true, holds: true });
    expect(await codeOf(run('voidPayment'))).toBe(`403 ${ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION}`);
    expect(calls).toEqual({ canAny: 1, refusal: ['payment.void'], device: 0 });
    // The same key on an unmarked verb still works (rule 24 reaches verbs, not keys).
    expect(await codeOf(run('recordPayment'))).toBe('passed');
  });

  it('a caller without the key is PERMISSION_DENIED first, never told about the password', async () => {
    const { run, calls } = setUp({ passwordIsDefault: true, holds: false });
    expect(await codeOf(run('voidPayment'))).toBe(`403 ${ErrorCode.PERMISSION_DENIED}`);
    expect(calls.refusal).toEqual([]);
  });

  it('a changed password passes; the marker also applies on a staff-only route', async () => {
    expect(await codeOf(setUp({ passwordIsDefault: false, holds: true }).run('voidPayment'))).toBe('passed');
    expect(await codeOf(setUp({ passwordIsDefault: false, holds: true }).run('staffInert'))).toBe('passed');
    const inert = setUp({ passwordIsDefault: true, holds: true });
    expect(await codeOf(inert.run('staffInert'))).toBe(`403 ${ErrorCode.DEFAULT_PASSWORD_BLOCKS_ACTION}`);
    expect(inert.calls.refusal).toEqual(['expense.payee_change']);
  });

  it('the marker on a route without a school session fails closed (500)', async () => {
    expect(await codeOf(setUp({ passwordIsDefault: false, holds: true }).run('publicInert'))).toBe(`500 ${ErrorCode.INTERNAL_ERROR}`);
  });

  it('@DeviceToken() resolves through the device-punch service and no session; with another rule it is ambiguous (500)', async () => {
    const { run, calls } = setUp({ passwordIsDefault: false, holds: true });
    expect(await codeOf(run('punch'))).toBe('passed');
    expect(calls).toEqual({ canAny: 0, refusal: [], device: 1 });
    expect(await codeOf(run('ambiguous'))).toBe(`500 ${ErrorCode.INTERNAL_ERROR}`);
    expect(calls.device).toBe(1);
  });
});
