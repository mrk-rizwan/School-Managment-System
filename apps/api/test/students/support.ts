// The slice 6 part A e2e harness: the real AppModule, real sessions (test/support/school-session)
// and rows written straight to the database (test/support/students). Every response body and log
// line is kept so a spec can assert that no B-Form or CNIC digits ever left the server (R16).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { loadEnv } from '../../src/config/env';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  type SchoolUserOptions,
} from '../support/school-session';
import { testDb, type TestSchool } from '../support/schools';
import {
  createGuardian,
  createStudent,
  enrol,
  linkGuardian,
  type TestSection,
} from '../support/students';

const ORIGIN = new URL(loadEnv().APP_URL).origin;
export const API = '/api/v1';
export const ID = /^[1-9][0-9]{0,18}$/;

export interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> | null };
}

export interface Signed {
  cookie: string;
  userId: bigint;
  staffId: bigint;
  cnic: string;
}

export interface Harness {
  app: NestExpressApplication;
  /** Every response body of the run. */
  bodies: string[];
  /** Every log line of the run. */
  logs: string[];
  get(path: string, cookie: string): Promise<request.Response>;
  send(
    method: 'post' | 'patch',
    path: string,
    body: object | undefined,
    cookie: string,
  ): Promise<request.Response>;
}

export async function createHarness(): Promise<Harness> {
  const logs: string[] = [];
  const bodies: string[] = [];
  const app = await createTestApp({ logStream: { write: (line: string) => void logs.push(line) } });
  const http = () => request(app.getHttpServer());
  const keep = (res: request.Response) => {
    bodies.push(res.text);
    return res;
  };
  return {
    app,
    bodies,
    logs,
    get: async (path, cookie) => keep(await http().get(`${API}${path}`).set('Cookie', cookie)),
    send: async (method, path, body, cookie) => {
      const req = http()[method](`${API}${path}`).set('Cookie', cookie).set('Origin', ORIGIN);
      return keep(await (body === undefined ? req : req.send(body)));
    },
  };
}

export const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

export async function signIn(
  school: TestSchool,
  systemRole: SchoolUserOptions['systemRole'],
): Promise<Signed> {
  const user = await createSchoolUser(testDb(), school, { systemRole });
  const { cookie } = await createSchoolSession(testDb(), school, user);
  return { cookie, userId: user.userId, staffId: user.staffId, cnic: user.cnic };
}

/**
 * An active student enrolled in `section`, with one guardian linked as primary contact and fee
 * payer: the state an admission leaves.
 */
export async function admitted(
  school: TestSchool,
  section: TestSection,
  opts: {
    fullName?: string;
    bForm?: string | null;
    rollNo?: number | null;
    admittedOn?: string;
  } = {},
) {
  const db = testDb();
  const student = await createStudent(db, school, {
    ...(opts.fullName === undefined ? {} : { fullName: opts.fullName }),
    ...(opts.bForm === undefined ? {} : { bForm: opts.bForm }),
    ...(opts.admittedOn === undefined ? {} : { admittedOn: opts.admittedOn }),
  });
  const enrolment = await enrol(db, school, student, section, {
    rollNo: opts.rollNo ?? null,
    ...(opts.admittedOn === undefined ? {} : { startedOn: opts.admittedOn }),
  });
  const guardian = await createGuardian(db, school);
  const link = await linkGuardian(db, school, student, guardian);
  return { student, enrolment, guardian, link };
}

/** The school_settings row (createSchool writes none), with student logins on or off. */
export async function setStudentLogin(school: TestSchool, enabled: boolean): Promise<void> {
  const db = testDb();
  const existing = await db.schoolSettings.findFirst({ where: { schoolId: school.id } });
  if (existing) {
    await db.schoolSettings.update({
      where: { schoolId_id: { schoolId: school.id, id: existing.id } },
      data: { studentLoginEnabled: enabled },
    });
  } else {
    await db.schoolSettings.create({
      data: { schoolId: school.id, feeDueDay: 10, studentLoginEnabled: enabled },
    });
  }
}

/** The audit rows of one subject, oldest first. */
export const auditFor = (school: TestSchool, subjectType: string, subjectId: bigint | string) =>
  testDb().auditLog.findMany({
    where: { schoolId: school.id, subjectType, subjectId: BigInt(subjectId) },
    orderBy: { id: 'asc' },
  });
