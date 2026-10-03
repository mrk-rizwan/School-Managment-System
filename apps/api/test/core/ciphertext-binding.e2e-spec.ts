// R104 end to end: an identity-number ciphertext is bound to its school, table and column (AAD
// `schoolId|table|column`, plan §3.6). Copied to another school's row or to another column it
// fails to decrypt, so the office reset that would derive a default password from it refuses,
// and nothing about the account changes. The unit form is in field-encryption.spec.ts; this
// proves the real rows and the real decrypt sites use the binding.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Mailer } from '../../src/modules/auth/mailer';
import { createTestApp } from './app';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createTwoSchools, testDb, type TwoSchools } from '../support/schools';
import { createGuardian } from '../support/students';
import { createGuardianUser, FakeMailer, ORIGIN } from '../school-auth/support';

describe('R104: an identity ciphertext only decrypts in its own school, table and column', () => {
  let app: NestExpressApplication;
  let schools: TwoSchools;
  let principalB: string;
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ overrides: [{ provide: Mailer, useValue: new FakeMailer() }] });
    schools = await createTwoSchools();
    const principal = await createSchoolUser(db(), schools.b, { systemRole: 'principal' });
    principalB = (await createSchoolSession(db(), schools.b, principal)).cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  const officeReset = (userId: bigint) =>
    http()
      .post(`/api/v1/users/${userId}/reset-password`)
      .set('Cookie', principalB)
      .set('Origin', ORIGIN)
      .send({ reason: 'Ciphertext binding check', clearEmail: false });

  const staffCnic = async (user: TestSchoolUser) =>
    (await db().staff.findFirst({ where: { schoolId: user.schoolId, id: user.staffId } }))?.cnic ?? null;

  async function plantStaffCnic(user: TestSchoolUser, ciphertext: string) {
    await db().staff.update({
      where: { schoolId_id: { schoolId: user.schoolId, id: user.staffId } },
      data: { cnic: ciphertext },
    });
  }

  async function expectRefusedAndUnchanged(user: TestSchoolUser) {
    const before = await db().user.findFirst({ where: { schoolId: user.schoolId, id: user.userId } });
    const res = await officeReset(user.userId);
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('IDENTITY_NUMBER_MISSING');
    const after = await db().user.findFirst({ where: { schoolId: user.schoolId, id: user.userId } });
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.passwordIsDefault).toBe(false);
    expect(await db().auditLog.count({ where: { schoolId: user.schoolId, subjectId: user.userId, action: 'user.office_reset' } })).toBe(0);
  }

  it('R104 (control): the untouched ciphertext decrypts and the office reset succeeds', async () => {
    const target = await createSchoolUser(db(), schools.b, { systemRole: 'teacher', password: 'own-password-1' }); // pragma: allowlist secret
    await officeReset(target.userId).expect(200);
  });

  it("R104: school A's staff CNIC ciphertext copied into school B's staff row fails to decrypt", async () => {
    const inA = await createSchoolUser(db(), schools.a, { systemRole: 'teacher' });
    const target = await createSchoolUser(db(), schools.b, { systemRole: 'teacher', password: 'own-password-2' }); // pragma: allowlist secret
    const copied = await staffCnic(inA);
    if (!copied) throw new Error('no ciphertext');
    await plantStaffCnic(target, copied);
    await expectRefusedAndUnchanged(target);
  });

  it("R104: a guardian CNIC ciphertext of the same school copied into staff.cnic fails to decrypt", async () => {
    const guardian = await createGuardian(db(), schools.b);
    const row = await db().guardian.findFirst({ where: { schoolId: schools.b.id, id: guardian.id } });
    if (!row?.cnic) throw new Error('no ciphertext');
    const target = await createSchoolUser(db(), schools.b, { systemRole: 'teacher', password: 'own-password-3' }); // pragma: allowlist secret
    await plantStaffCnic(target, row.cnic);
    await expectRefusedAndUnchanged(target);
  });

  it("R104: a staff CNIC ciphertext copied into a guardian's cnic in another school is never shown, even masked", async () => {
    const inA = await createSchoolUser(db(), schools.a, { systemRole: 'teacher' });
    const copied = await staffCnic(inA);
    if (!copied) throw new Error('no ciphertext');
    const parent = await createGuardianUser(db(), schools.b);
    await db().guardian.update({
      where: { schoolId_id: { schoolId: schools.b.id, id: parent.guardianId } },
      data: { cnic: copied },
    });
    const res = await http().get(`/api/v1/guardians/${parent.guardianId}`).set('Cookie', principalB);
    expect(res.status).not.toBe(200);
    const maskedA = `${inA.cnic.slice(0, 5)}-*****-${inA.cnic.slice(12)}`;
    expect(res.text).not.toContain(maskedA);
    expect(res.text).not.toContain(inA.cnic);
  });
});
