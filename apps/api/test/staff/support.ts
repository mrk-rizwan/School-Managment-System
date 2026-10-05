// Shared by the slice-4 suites (contracts/slice-4.md): the real AppModule plus a scope probe,
// sessions written straight to the database, and the school's "today" (Asia/Karachi).
import { Controller, Get, Module, Query } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability } from '@asms/shared';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { RequireCapability } from '../../src/common/auth/route-access';
import {
  CurrentSchoolSession,
  scopeOf,
  type SchoolSessionContext,
} from '../../src/common/auth/school-session';
import { ApiErrors } from '../../src/common/openapi';
import { NoQueryDto } from '../../src/common/validation';
import { loadEnv } from '../../src/config/env';
import { addDays, todayIn } from '../../src/common/school-clock';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { testDb, type TestSchool } from '../support/schools';

export const ORIGIN = new URL(loadEnv().APP_URL).origin;
export const ID = /^[1-9][0-9]{0,18}$/;
/** Every test school runs on the schema default time zone. */
export const SCHOOL_TZ = 'Asia/Karachi';

/** The school's today shifted by `offset` days, as 'YYYY-MM-DD'. */
export const schoolDay = (offset = 0): string =>
  addDays(todayIn(SCHOOL_TZ), offset).toISOString().slice(0, 10);

export const dashed = (d: string) => `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
export const masked = (d: string) => `${d.slice(0, 5)}-*****-${d.slice(12)}`;

/** Reports the scope the guard bound for a teacher-scoped capability (R79). Test-only. */
@Controller('test-scope')
class ScopeProbeController {
  @Get()
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiErrors(401, 403)
  scope(@Query() _q: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext) {
    const scope = scopeOf(session);
    return scope.kind === 'all' ? { kind: 'all' } : { kind: 'sections', ids: scope.ids.map(String) };
  }
}

@Module({ controllers: [ScopeProbeController] })
export class ScopeProbeModule {}

export interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> | null };
}
export const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

export type Role = 'principal' | 'office_staff' | 'teacher';

export interface Caller extends TestSchoolUser {
  cookie: string;
}

/**
 * The app and HTTP helpers. Every response body and log line is kept, so a suite can assert at
 * the end that no identity number left the server (R16).
 */
export class StaffHarness {
  app!: NestExpressApplication;
  readonly bodies: string[] = [];
  readonly logs: string[] = [];
  readonly db = testDb();

  async start(): Promise<void> {
    this.app = await createTestApp({
      imports: [ScopeProbeModule],
      logStream: { write: (line: string) => void this.logs.push(line) },
    });
  }

  private record<T extends { text: string }>(res: T): T {
    this.bodies.push(res.text);
    return res;
  }

  async get(path: string, cookie: string) {
    return this.record(await request(this.app.getHttpServer()).get(path).set('Cookie', cookie));
  }

  async send(method: 'post' | 'patch', path: string, body: object, cookie: string) {
    return this.record(
      await request(this.app.getHttpServer())
        [method](path)
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .send(body),
    );
  }

  /**
   * A session context for a service-level call by `userId`, with `extra` capabilities added, as
   * slice-7 grants would add them: the only way to reach R12, R14 and R72 on these routes while
   * role.manage and staff.status.change come only with the principal role.
   */
  async widenedSession(
    school: TestSchool,
    userId: bigint,
    extra: Capability[],
  ): Promise<SchoolSessionContext> {
    const access = await this.app.get(PermissionsService).load(school.id, userId);
    if (!access) throw new Error('widenedSession: no such user');
    return {
      schoolId: school.id,
      sessionId: 0n,
      tokenHash: '',
      channel: 'cookie',
      expiresAt: new Date(Date.now() + 60_000),
      school: { id: school.id, name: 'Test School', shortCode: school.shortCode, status: 'active' },
      // Effective and nominal alike (a grant adds both): rule 24's in-service overrides read the
      // nominal lines (PermissionsService.holdsNominally).
      access: {
        ...access,
        capabilities: new Set([...access.capabilities, ...extra]),
        lines: [
          ...access.lines,
          ...extra
            .filter((capability) => !access.lines.some((line) => line.capability === capability))
            .map((capability) => ({ capability, sources: [], scope: 'all' as const })),
        ],
      },
    };
  }

  /** A staff member with a login, one live role, and a cookie session. */
  async caller(school: TestSchool, systemRole: Role, fullName?: string): Promise<Caller> {
    const user = await createSchoolUser(this.db, school, {
      systemRole,
      ...(fullName === undefined ? {} : { fullName }),
    });
    const { cookie } = await createSchoolSession(this.db, school, user);
    return { ...user, cookie };
  }
}
