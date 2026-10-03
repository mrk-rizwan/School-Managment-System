// F3 (Phase 1 security review): the identity-probe budget counts identity numbers, not requests
// (contracts/slice-6.md §3.4, §6.3 step 1). POST /admissions spends one per number it carries —
// the student's B-Form and each new guardian's CNIC — so five numbers in one admission cost what
// five lookups cost. The guard runs before validation, so a body that then fails validation has
// already spent its budget: that is what lets these tests use bodies that never create anything.
import { randomBytes } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { loadEnv } from '../../src/config/env';
import { admissionProbeCost } from '../../src/modules/people/admissions/admissions.controller';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser, randomIdentityDigits } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';

const ORIGIN = new URL(loadEnv().APP_URL).origin;
const PER_MINUTE = 30;

const newGuardian = () => ({ newGuardian: { cnic: randomIdentityDigits() } });

describe('identity-probe budget per identity number (e2e)', () => {
  const db = testDb();
  let app: NestExpressApplication;
  let school: TestSchool;

  const http = () => request(app.getHttpServer());

  /** A fresh office user, so every test starts with a full budget. */
  const office = async (): Promise<string> => {
    const user = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    return (await createSchoolSession(db, school, user)).cookie;
  };

  const admit = (cookie: string, body: object) =>
    http()
      .post('/api/v1/admissions')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', `adm_${randomBytes(12).toString('base64url')}`)
      .send(body);

  /** Lookups until the budget refuses one; returns how many were allowed. */
  const lookupsLeft = async (cookie: string): Promise<number> => {
    for (let allowed = 0; allowed <= PER_MINUTE; allowed++) {
      const res = await http()
        .post('/api/v1/students/lookup')
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .send({ bForm: '1111111111111' });
      if (res.status === 429) return allowed;
      expect(res.status).toBe(200);
    }
    throw new Error('the identity-probe budget never refused a lookup');
  };

  beforeAll(async () => {
    app = await createTestApp();
    school = await createSchool();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('an admission with a B-Form and four new guardians spends five', async () => {
    const cookie = await office();
    const res = await admit(cookie, {
      student: { bForm: randomIdentityDigits() },
      guardians: [newGuardian(), newGuardian(), newGuardian(), newGuardian()],
    });
    expect(res.status).toBe(422);
    expect(await lookupsLeft(cookie)).toBe(PER_MINUTE - 5);
  });

  it('an admission carrying no identity number still spends one', async () => {
    const cookie = await office();
    expect((await admit(cookie, { guardians: [{ guardianId: '1' }] })).status).toBe(422);
    expect(await lookupsLeft(cookie)).toBe(PER_MINUTE - 1);
  });

  it('an admission is refused once its numbers exceed what is left', async () => {
    const cookie = await office();
    for (let i = 0; i < PER_MINUTE - 3; i++) {
      expect(
        (
          await http()
            .post('/api/v1/students/lookup')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ bForm: '1111111111111' })
        ).status,
      ).toBe(200);
    }
    const res = await admit(cookie, {
      student: { bForm: randomIdentityDigits() },
      guardians: [newGuardian(), newGuardian(), newGuardian()],
    });
    expect(res.status).toBe(429);
  });
});

describe('admissionProbeCost', () => {
  const cost = (body: unknown) =>
    admissionProbeCost({ body } as Parameters<typeof admissionProbeCost>[0]);

  it('counts the B-Form and each new guardian CNIC string; never less than one', () => {
    expect(cost({ student: { bForm: 'x' }, guardians: [newGuardian(), newGuardian()] })).toBe(3);
    expect(cost({ student: { bForm: null }, guardians: [{ guardianId: '1' }] })).toBe(1);
    expect(cost(undefined)).toBe(1);
    expect(cost('not an object')).toBe(1);
    expect(cost({ guardians: [{ newGuardian: { cnic: 42 } }, { newGuardian: [] }] })).toBe(1);
  });

  it('counts at most the four guardians an admission takes', () => {
    const many = Array.from({ length: 50 }, newGuardian);
    expect(cost({ student: { bForm: 'x' }, guardians: many })).toBe(5);
  });
});
