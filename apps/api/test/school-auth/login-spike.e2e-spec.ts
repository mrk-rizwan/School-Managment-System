// Contract slice-2 §3.1 step 6: spraying many CNICs at one school never trips a per-account lock,
// so 50 failed logins for one school within 10 minutes record one login_failure_spike row in
// platform_audit_log (no platform actor: CHECK platform_audit_log_actor_check allows it).
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../core/app';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { nextIp, ORIGIN } from './support';

describe('login failure spike', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('writes one platform_audit_log row at the 50th failure in the window; every failure stays a plain 401', async () => {
    const school = await createSchool();
    const spikes = () =>
      testDb().platformAuditLog.findMany({
        where: { schoolId: school.id, action: 'login_failure_spike' },
      });
    for (let i = 0; i < 55; i++) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .set('X-Forwarded-For', nextIp())
        .send({ schoolCode: school.shortCode, username: `${2000000000000 + i}`, password: 'spray' });
      expect(res.status).toBe(401);
      // The row appears exactly at the threshold, not before.
      if (i === 48) expect(await spikes()).toHaveLength(0);
      if (i === 49) expect(await spikes()).toHaveLength(1);
    }
    const rows = await spikes();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      actorPlatformUserId: null,
      schoolId: school.id,
      subjectType: 'school',
      subjectId: school.id,
    });
    const metadata = row?.metadata as { failures: number; windowStartedAt: string };
    expect(metadata.failures).toBe(50);
    expect(metadata.windowStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
