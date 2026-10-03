// Wave-A security fixes that need the real app: the row scope travels from the access guard to
// the handler (scopeOf(session)), and an identity number split by spaces or `+` in a GET query
// is refused and never reaches a log line.
import { Controller, Get, Module, Query } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability } from '@asms/shared';
import { RequireCapability, RequireStaff } from '../../src/common/auth/route-access';
import { CurrentSchoolSession, scopeOf, type SchoolSessionContext } from '../../src/common/auth/school-session';
import { ApiErrors } from '../../src/common/openapi';
import { NoQueryDto } from '../../src/common/validation';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';

/** Reports the scope the guard attached, bigint ids as strings. */
@Controller('test-scope')
class ScopeProbeController {
  @Get('students')
  @RequireCapability(Capability.STUDENT_VIEW)
  @ApiErrors(401, 403)
  students(@Query() _q: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext) {
    const scope = scopeOf(session);
    return scope.kind === 'all' ? scope : { kind: scope.kind, ids: scope.ids.map(String) };
  }

  /** A @RequireStaff route has no capability scope: asking for one is a 500, never "all". */
  @Get('no-scope')
  @RequireStaff()
  @ApiErrors(401, 403)
  noScope(@Query() _q: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext) {
    return scopeOf(session);
  }

  @Get('either')
  @RequireCapability(Capability.SCHOOL_SETTINGS_MANAGE, Capability.STUDENT_VIEW)
  @ApiErrors(401, 403)
  either(@Query() _q: NoQueryDto, @CurrentSchoolSession() session: SchoolSessionContext) {
    return { kind: scopeOf(session).kind };
  }
}

@Module({ controllers: [ScopeProbeController] })
class ScopeProbeModule {}

describe('wave-A security fixes', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  const logs: string[] = [];
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({
      imports: [ScopeProbeModule],
      logStream: { write: (line: string) => void logs.push(line) },
    });
    school = await createSchool();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const cookieFor = async (systemRole: 'principal' | 'office_staff' | 'teacher') => {
    const user = await createSchoolUser(db(), school, { systemRole });
    return (await createSchoolSession(db(), school, user)).cookie;
  };

  describe('scopeOf: the guard hands the handler its row scope', () => {
    it('a teacher gets the sections scope (none until slice 4), office staff the whole school', async () => {
      const teacher = await http().get('/api/v1/test-scope/students').set('Cookie', await cookieFor('teacher')).expect(200);
      expect(teacher.body).toEqual({ kind: 'sections', ids: [] });
      const office = await http().get('/api/v1/test-scope/students').set('Cookie', await cookieFor('office_staff')).expect(200);
      expect(office.body).toEqual({ kind: 'all' });
    });

    it('any-of keys take the widest scope the caller holds', async () => {
      const teacher = await http().get('/api/v1/test-scope/either').set('Cookie', await cookieFor('teacher')).expect(200);
      expect(teacher.body).toEqual({ kind: 'sections' });
      const principal = await http().get('/api/v1/test-scope/either').set('Cookie', await cookieFor('principal')).expect(200);
      expect(principal.body).toEqual({ kind: 'all' });
    });

    it('a route with no capability check has no scope to read (500, not a silent default)', async () => {
      await http().get('/api/v1/test-scope/no-scope').set('Cookie', await cookieFor('office_staff')).expect(500);
    });
  });

  describe('GET /users?q= with a split identity number', () => {
    it('is 422, and the request line in the log is scrubbed', async () => {
      const office = await cookieFor('office_staff');
      for (const q of ['35202+1234567+1', '35202%201234567%201', '35202%2B1234567%2B1', '35202+-+1234567+1']) {
        await http().get(`/api/v1/users?q=${q}`).set('Cookie', office).expect(422);
      }
      // Wait for the request-completed lines to be written.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const userLines = logs.filter((line) => line.includes('/api/v1/users?q='));
      expect(userLines.length).toBeGreaterThanOrEqual(4);
      for (const line of logs) {
        expect(line).not.toMatch(/\d{5}(?:[\s+-]|%20|%2B|%2D)+\d{7}/i);
        expect(line).not.toContain('1234567');
      }
    });
  });
});
