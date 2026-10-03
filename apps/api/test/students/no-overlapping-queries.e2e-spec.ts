// §3.3: no concurrent statements inside one interactive transaction, for the slice 6 part A flows.
// The wrapper is the one in test/academics/no-overlapping-queries.e2e-spec.ts: pg's Client.query
// is wrapped and a query issued while another is still queued on the same client is counted.
import { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { loadEnv } from '../../src/config/env';
import { createTestApp } from '../core/app';
import { randomIdentityDigits } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import {
  createClass,
  createClassWithSection,
  createGuardian,
  createSection,
  createStudent,
  isoDay,
  linkGuardian,
} from '../support/students';
import { admitted, setStudentLogin, signIn } from './support';

const ORIGIN = new URL(loadEnv().APP_URL).origin;

describe('no overlapping statements in a transaction (students)', () => {
  let app: NestExpressApplication;
  let overlaps = 0;
  const proto: object = Client.prototype;
  const original: unknown = Reflect.get(proto, 'query');
  const db = testDb();

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

  it('students, guardian links and enrolments run without one', async () => {
    const school = await createSchool();
    const { cookie } = await signIn(school, 'principal');
    await setStudentLogin(school, true);
    const { klass, section } = await createClassWithSection(db, school);
    const digits = randomIdentityDigits();
    const { student, enrolment, guardian } = await admitted(school, section, { bForm: digits });
    const call = async (
      method: 'get' | 'post' | 'patch',
      path: string,
      status: number,
      body?: object,
    ) => {
      let req = request(app.getHttpServer())[method](`/api/v1${path}`).set('Cookie', cookie);
      if (method !== 'get') req = req.set('Origin', ORIGIN).send(body ?? {});
      const res = await req;
      expect({ path, status: res.status }).toEqual({ path, status });
      return res.body as Record<string, unknown>;
    };

    await call('get', '/students?sort=rollNo&hasLogin=false&q=st', 200);
    await call('get', `/students/${student.id}`, 200);
    await call('get', `/students/${student.id}/guardian-links?includeEnded=true`, 200);
    await call('get', `/students/${student.id}/enrolments`, 200);
    await call('post', '/students/lookup', 200, { bForm: digits });
    await call('patch', `/students/${student.id}`, 200, {
      fullName: 'Overlap Student',
      notes: 'n',
    });
    // A B-Form held by another student: the 409 is answered from a read of the holder.
    const held = randomIdentityDigits();
    await createStudent(db, school, { bForm: held });
    await call('patch', `/students/${student.id}`, 409, { bForm: held });

    const other = await createGuardian(db, school);
    const created = await call('post', `/students/${student.id}/guardian-links`, 201, {
      guardianId: other.id.toString(),
      relationship: 'mother',
      isPrimaryContact: true,
      isFeePayer: true,
      canLogin: true,
    });
    await call('patch', `/guardian-links/${String(created.id)}`, 200, { relationship: 'guardian' });
    const third = await linkGuardian(db, school, student, await createGuardian(db, school), {
      isPrimaryContact: false,
      isFeePayer: false,
    });
    await call('post', `/guardian-links/${third.id}/end`, 200, { reason: 'Overlap check' });
    await call('get', `/guardians/${guardian.id}/students`, 200);
    await call('post', `/guardians/${other.id}/issue-login`, 201);

    await call('patch', `/enrolments/${enrolment.id}`, 200, { rollNo: 3 });
    const sibling = await createSection(db, school, klass);
    await call('post', `/enrolments/${enrolment.id}/change-section`, 200, {
      sectionId: sibling.id.toString(),
    });
    const target = await createClass(db, school, { id: klass.academicYearId });
    const targetSection = await createSection(db, school, target);
    await call('post', `/enrolments/${enrolment.id}/change-class`, 200, {
      classId: target.id.toString(),
      sectionId: targetSection.id.toString(),
      effectiveOn: isoDay(),
      reason: 'Overlap check',
    });

    await call('post', `/students/${student.id}/issue-login`, 201);
    await call('post', `/students/${student.id}/change-status`, 200, {
      status: 'withdrawn',
      reason: 'Overlap check',
      effectiveOn: isoDay(),
    });
    await call('get', `/students/${student.id}/status-changes`, 200);

    expect(overlaps).toBe(0);
  });
});
