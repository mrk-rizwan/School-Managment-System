// §3.3: no concurrent statements inside one interactive transaction, for the academic-structure
// (slice 3) and guardian (slice 5) flows. The wrapper is the one in
// test/school-auth/no-overlapping-queries.e2e-spec.ts: pg's Client.query is wrapped and a query
// issued while another is still queued on the same client is counted. Prisma loading several
// relations of one select concurrently is the usual cause.
import { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  randomIdentityDigits,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createStudent, linkGuardian } from '../support/students';
import { tag } from './support';

const API = '/api/v1';
const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3000').origin;

describe('no overlapping statements in a transaction (academics, guardians)', () => {
  let app: NestExpressApplication;
  let overlaps = 0;
  const proto: object = Client.prototype;
  const original: unknown = Reflect.get(proto, 'query');
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    if (typeof original !== 'function') throw new Error('pg Client.query not found');
    Reflect.set(proto, 'query', function (this: object, ...args: unknown[]): unknown {
      const queue: unknown = Reflect.get(this, '_queryQueue');
      if (Array.isArray(queue) && queue.length > 0 && Reflect.get(this, 'pipeline') !== true) {
        overlaps++;
      }
      const result: unknown = Reflect.apply(original, this, args);
      return result;
    });
    app = await createTestApp();
  });

  afterAll(async () => {
    Reflect.set(proto, 'query', original);
    await app.close();
    await closeTestDb();
  });

  /** A signed-in principal of a new school (every academics and guardian capability). */
  async function signIn(): Promise<string> {
    const school = await createSchool();
    const user = await createSchoolUser(testDb(), school, { systemRole: 'principal' });
    return (await createSchoolSession(testDb(), school, user)).cookie;
  }

  const call = async (
    method: 'get' | 'post' | 'patch',
    path: string,
    cookie: string,
    status: number,
    body?: object,
  ): Promise<Record<string, unknown>> => {
    let req = http()[method](`${API}${path}`).set('Cookie', cookie);
    if (method !== 'get') req = req.set('Origin', ORIGIN).send(body ?? {});
    const res = await req;
    expect({ path, status: res.status }).toEqual({ path, status });
    return res.body as Record<string, unknown>;
  };
  const idOf = (body: Record<string, unknown>): string => String(body.id);
  /** Guardian issue-login needs a live link with can_login (contracts/slice-6.md §9). */
  const allowLogin = async (school: TestSchool, guardianId: string): Promise<void> => {
    const student = await createStudent(testDb(), school);
    await linkGuardian(testDb(), school, student, { id: BigInt(guardianId) }, { canLogin: true });
  };

  it('the wrapper sees an overlap (the checks below are not vacuous)', async () => {
    // A select loading several relations: Prisma issues their queries concurrently.
    const school = await createSchool();
    const user = await createSchoolUser(testDb(), school, { systemRole: 'teacher' });
    await testDb().$transaction(async (tx) => {
      await tx.user.findFirst({
        where: { schoolId: school.id, id: user.userId },
        select: {
          id: true,
          staff: { select: { status: true } },
          guardian: { select: { fullName: true } },
          roles: { select: { systemRole: true } },
        },
      });
    });
    expect(overlaps).toBeGreaterThan(0);
    overlaps = 0;
  });

  it('academic years, classes, sections, copy-sections and subjects run without one', async () => {
    const cookie = await signIn();
    const year = (name: string) =>
      call('post', '/academic-years', cookie, 201, {
        name,
        startsOn: '2026-04-01',
        endsOn: '2027-03-31',
      });

    const y1 = idOf(await year(`Y ${tag()}`));
    await call('patch', `/academic-years/${y1}`, cookie, 200, { name: `Y ${tag()}` });
    await call('post', `/academic-years/${y1}/activate`, cookie, 200);
    await call('get', '/academic-years?status=active', cookie, 200);
    await call('get', `/academic-years/${y1}`, cookie, 200);

    const newClass = async (academicYearId: string) =>
      idOf(
        await call('post', '/classes', cookie, 201, {
          academicYearId,
          name: `C ${tag()}`,
          attendanceMode: 'daily',
        }),
      );
    const c1 = await newClass(y1);
    const c2 = await newClass(y1);
    const y2 = idOf(await year(`Y ${tag()}`));
    // Moving years locks both years and checks for sections.
    await call('patch', `/classes/${c2}`, cookie, 200, { academicYearId: y2, sortOrder: 2 });
    await call('get', `/classes?academicYearId=${y1}&q=%25%25`, cookie, 200);
    await call('get', `/classes/${c1}`, cookie, 200);

    const s1 = idOf(await call('post', `/classes/${c1}/sections`, cookie, 201, { name: 'A' }));
    await call('post', `/classes/${c1}/sections`, cookie, 201, { name: 'B', capacity: 30 });
    await call('patch', `/sections/${s1}`, cookie, 200, { capacity: 40 });
    await call('get', `/classes/${c1}/sections?includeArchived=true`, cookie, 200);
    await call('get', `/sections/${s1}`, cookie, 200);
    await call('post', `/classes/${c2}/copy-sections`, cookie, 200, { fromClassId: c1 });
    await call('post', `/sections/${s1}/archive`, cookie, 200, { reason: 'Merged' });
    await call('post', `/classes/${c1}/archive`, cookie, 200, {});

    const subject = idOf(
      await call('post', '/subjects', cookie, 201, { name: `S ${tag()}`, code: 'S-1' }),
    );
    await call('patch', `/subjects/${subject}`, cookie, 200, { code: null });
    await call('get', '/subjects?q=s-&includeArchived=true', cookie, 200);
    await call('get', `/subjects/${subject}`, cookie, 200);
    await call('post', `/subjects/${subject}/archive`, cookie, 200, {});

    await call('post', `/academic-years/${y2}/close`, cookie, 200);

    expect(overlaps).toBe(0);
  });

  it('guardian create, list, read, PATCH, lookup and issue-login run without one', async () => {
    const own = await createSchool();
    const ownUser = await createSchoolUser(testDb(), own, { systemRole: 'principal' });
    const cookie = (await createSchoolSession(testDb(), own, ownUser)).cookie;
    const cnic = randomIdentityDigits();
    const guardian = idOf(
      await call('post', '/guardians', cookie, 201, {
        fullName: 'Overlap Parent',
        cnic,
        phone: '03001234567',
        contactCapability: 'whatsapp',
      }),
    );
    const other = idOf(
      await call('post', '/guardians', cookie, 201, {
        fullName: 'Overlap Other',
        phone: '03001234567',
        contactCapability: 'keypad',
      }),
    );
    // A CNIC already held is answered from a read of the holder (the 409 pointer).
    await call('post', '/guardians', cookie, 409, {
      fullName: 'Duplicate',
      cnic,
      contactCapability: 'keypad',
    });
    await call('get', '/guardians?hasLogin=false&q=overlap', cookie, 200);
    await call('get', `/guardians/${guardian}`, cookie, 200);
    await call('get', `/guardians/${guardian}/students`, cookie, 200);
    await call('patch', `/guardians/${other}`, cookie, 200, {
      fullName: 'Overlap Other Two',
      email: 'other@example.com',
      cnic: randomIdentityDigits(),
    });
    await call('post', '/guardians/lookup', cookie, 200, { cnic });
    await call('post', '/guardians/lookup', cookie, 200, { phone: '03001234567' });
    await allowLogin(own, guardian);
    await call('post', `/guardians/${guardian}/issue-login`, cookie, 201);

    // Linking onto an existing login (R22): the user is read, locked and permission-checked.
    const school = await createSchool();
    const principal = await createSchoolUser(testDb(), school, { systemRole: 'principal' });
    const office = await createSchoolUser(testDb(), school, { systemRole: 'office_staff' });
    const principalCookie = (await createSchoolSession(testDb(), school, principal)).cookie;
    const linked = idOf(
      await call('post', '/guardians', principalCookie, 201, {
        fullName: 'Office Parent',
        cnic: office.cnic,
        contactCapability: 'whatsapp',
      }),
    );
    await allowLogin(school, linked);
    await call('post', `/guardians/${linked}/issue-login`, principalCookie, 201);

    expect(overlaps).toBe(0);
  });
});
