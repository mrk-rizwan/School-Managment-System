// GET|PATCH /school/settings (contract slice-2 §6): R62 for school_settings through the API, R80.
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../core/app';
import { createSchoolSession, createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { ORIGIN, pause } from './support';

type Settings = { feeDueDay: number; studentLoginEnabled: boolean; updatedAt: string };

describe('school settings', () => {
  let app: NestExpressApplication;
  const db = () => testDb();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  async function principalOf(school: TestSchool): Promise<string> {
    const p = await createSchoolUser(db(), school, { systemRole: 'principal' });
    return (await createSchoolSession(db(), school, p)).cookie;
  }

  async function schoolWithSettings(status: 'active' | 'suspended' = 'active'): Promise<TestSchool> {
    const school = await createSchool({ status });
    await db().schoolSettings.create({ data: { schoolId: school.id, feeDueDay: 10 } });
    return school;
  }

  const patch = (cookie: string, body: object) =>
    http().patch('/api/v1/school/settings').set('Cookie', cookie).set('Origin', ORIGIN).send(body);

  it('reads and updates the settings, auditing only a real change', async () => {
    const school = await schoolWithSettings();
    const cookie = await principalOf(school);
    const before = (await http().get('/api/v1/school/settings').set('Cookie', cookie).expect(200)).body as Settings;
    expect(before).toMatchObject({ feeDueDay: 10, studentLoginEnabled: false });
    const after = (await patch(cookie, { feeDueDay: 15, studentLoginEnabled: true }).expect(200)).body as Settings;
    expect(after).toMatchObject({ feeDueDay: 15, studentLoginEnabled: true });
    await patch(cookie, {}).expect(200);
    await patch(cookie, { feeDueDay: 15 }).expect(200);
    const rows = await db().auditLog.findMany({ where: { schoolId: school.id, action: 'school_settings.updated' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({
      changes: { feeDueDay: { from: 10, to: 15 }, studentLoginEnabled: { from: false, to: true } },
    });
  });

  it('422 for out-of-range, null, non-integer and unknown fields', async () => {
    const school = await schoolWithSettings();
    const cookie = await principalOf(school);
    for (const body of [{ feeDueDay: 29 }, { feeDueDay: 0 }, { feeDueDay: null }, { feeDueDay: 10.5 }, { studentLoginEnabled: null }, { studentLoginEnabled: 'yes' }, { schoolId: '1' }]) {
      await patch(cookie, body).expect(422);
    }
  });

  it('office staff (no school.settings.manage) is 403', async () => {
    const school = await schoolWithSettings();
    const clerk = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const { cookie } = await createSchoolSession(db(), school, clerk);
    await http().get('/api/v1/school/settings').set('Cookie', cookie).expect(403);
    await patch(cookie, { feeDueDay: 12 }).expect(403);
  });

  it('R62: each school reads and writes only its own row', async () => {
    const a = await schoolWithSettings();
    const b = await schoolWithSettings();
    const aCookie = await principalOf(a);
    const bCookie = await principalOf(b);
    await patch(aCookie, { feeDueDay: 20 }).expect(200);
    expect(((await http().get('/api/v1/school/settings').set('Cookie', bCookie).expect(200)).body as Settings).feeDueDay).toBe(10);
    await patch(bCookie, { feeDueDay: 5 }).expect(200);
    expect(((await http().get('/api/v1/school/settings').set('Cookie', aCookie).expect(200)).body as Settings).feeDueDay).toBe(20);
  });

  it('the settings lock never rewinds updated_at when another transaction changed the row first', async () => {
    const school = await schoolWithSettings();
    const cookie = await principalOf(school);
    const before = await db().schoolSettings.findFirst({ where: { schoolId: school.id } });
    if (!before) throw new Error('no settings row');
    const later = new Date(before.updatedAt.getTime() + 60_000);
    // Another transaction changes the row and holds it; the PATCH reads the old row, then waits.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let changed = () => {};
    const isChanged = new Promise<void>((resolve) => (changed = resolve));
    const other = db().$transaction(
      async (tx) => {
        await tx.schoolSettings.updateMany({ where: { schoolId: school.id }, data: { feeDueDay: 20, updatedAt: later } });
        changed();
        await held;
      },
      { timeout: 10_000 },
    );
    await isChanged;
    let settled = false;
    // Same value as the other transaction wrote: nothing to change, so only the lock writes.
    const patched = patch(cookie, { feeDueDay: 20 }).then((res) => {
      settled = true;
      return res;
    });
    await pause(500);
    expect(settled).toBe(false);
    release();
    await other;
    const res = await patched;
    expect(res.status).toBe(200);
    expect(res.body as Settings).toMatchObject({ feeDueDay: 20, updatedAt: later.toISOString() });
    const after = await db().schoolSettings.findFirst({ where: { schoolId: school.id } });
    expect(after?.updatedAt.toISOString()).toBe(later.toISOString());
    expect(await db().auditLog.count({ where: { schoolId: school.id, action: 'school_settings.updated' } })).toBe(0);
  });

  it('R80 lifted (contracts/slice-9.md §10 a): a suspended school reads and patches its settings', async () => {
    const school = await schoolWithSettings('suspended');
    const cookie = await principalOf(school);
    await http().get('/api/v1/school/settings').set('Cookie', cookie).expect(200);
    await patch(cookie, { feeDueDay: 12 }).expect(200);
  });

  // ---------------------------------------------------------- contracts/slice-9.md §4 (plan §4.5)

  it('§4.5: GET returns the Phase 2 defaults and the platform-set SMS cap', async () => {
    const school = await schoolWithSettings();
    await db().school.update({ where: { id: school.id }, data: { smsMonthlyCap: 750 } });
    const cookie = await principalOf(school);
    const body = (await http().get('/api/v1/school/settings').set('Cookie', cookie).expect(200)).body as Record<string, unknown>;
    expect(body).toMatchObject({
      periodsPerDay: 8,
      weeklyOffDays: [0],
      attendanceAmendWindowDays: 3,
      registerDeadlineTime: '10:00',
      absenceAlertTime: '09:30',
      lateAdviceEnabled: false,
      lateCountsAs: 'present',
      lateCutoffTime: null,
      leaveCountsAs: 'excused',
      smsMonthlyCap: 750,
      // Phase 3 (phase-3-financial.md §1.1) adds the four SMS-allowed fee types to the default.
      smsAllowedTypes: [
        'absence_alert',
        'late_advice',
        'attendance_corrected',
        'announcement_urgent',
        'holiday_notice',
        'fee_due_reminder',
        'fee_overdue',
        'receipt_issued',
        'payment_claim_rejected',
      ],
      remarkDefaultVisibility: 'guardian',
      remarkNotifyGuardians: false,
    });
  });

  it('§4.5: PATCH writes every new field, normalises arrays and audits one action with scalar changes', async () => {
    const school = await schoolWithSettings();
    const cookie = await principalOf(school);
    const res = await patch(cookie, {
      periodsPerDay: 6,
      weeklyOffDays: [6, 0],
      attendanceAmendWindowDays: 0,
      registerDeadlineTime: '09:15',
      absenceAlertTime: '10:45',
      lateAdviceEnabled: true,
      lateCountsAs: 'absent_after_cutoff',
      lateCutoffTime: '08:30',
      leaveCountsAs: 'absent',
      smsAllowedTypes: ['holiday_notice', 'absence_alert', 'announcement_normal'],
      remarkDefaultVisibility: 'student',
      remarkNotifyGuardians: true,
    }).expect(200);
    expect(res.body).toMatchObject({
      periodsPerDay: 6,
      weeklyOffDays: [0, 6],
      registerDeadlineTime: '09:15',
      absenceAlertTime: '10:45',
      lateCutoffTime: '08:30',
      smsAllowedTypes: ['absence_alert', 'announcement_normal', 'holiday_notice'],
    });
    const rows = await db().auditLog.findMany({ where: { schoolId: school.id, action: 'school_settings.updated' } });
    expect(rows).toHaveLength(1);
    const changes = (rows[0]?.metadata as { changes: Record<string, { from: unknown; to: unknown }> }).changes;
    expect(changes.weeklyOffDays).toEqual({ from: '0', to: '0,6' });
    expect(changes.smsAllowedTypes?.to).toBe('absence_alert,announcement_normal,holiday_notice');
    expect(changes.lateCutoffTime).toEqual({ from: null, to: '08:30' });
    // The same values again change nothing and audit nothing; [] is a real value for both arrays.
    await patch(cookie, { weeklyOffDays: [0, 6], smsAllowedTypes: ['announcement_normal', 'holiday_notice', 'absence_alert'] }).expect(200);
    expect(await db().auditLog.count({ where: { schoolId: school.id, action: 'school_settings.updated' } })).toBe(1);
    const cleared = await patch(cookie, { weeklyOffDays: [], smsAllowedTypes: [] }).expect(200);
    expect(cleared.body).toMatchObject({ weeklyOffDays: [], smsAllowedTypes: [] });
  });

  it('§4.5: 422 for out-of-range values, a read-only cap, ineligible SMS types and a missing late cut-off', async () => {
    const school = await schoolWithSettings();
    const cookie = await principalOf(school);
    const refused: [object, string, string][] = [
      [{ periodsPerDay: 0 }, 'periodsPerDay', 'INVALID_VALUE'],
      [{ periodsPerDay: 13 }, 'periodsPerDay', 'INVALID_VALUE'],
      [{ weeklyOffDays: [0, 1, 2, 3, 4, 5, 6] }, 'weeklyOffDays', 'INVALID_VALUE'],
      [{ weeklyOffDays: [1, 1] }, 'weeklyOffDays', 'INVALID_VALUE'],
      [{ weeklyOffDays: [7] }, 'weeklyOffDays', 'INVALID_VALUE'],
      [{ weeklyOffDays: null }, 'weeklyOffDays', 'INVALID_VALUE'],
      [{ attendanceAmendWindowDays: 31 }, 'attendanceAmendWindowDays', 'INVALID_VALUE'],
      [{ registerDeadlineTime: '24:00' }, 'registerDeadlineTime', 'INVALID_VALUE'],
      [{ absenceAlertTime: '9:30' }, 'absenceAlertTime', 'INVALID_VALUE'],
      [{ lateCountsAs: 'sometimes' }, 'lateCountsAs', 'INVALID_VALUE'],
      [{ smsMonthlyCap: 10 }, 'smsMonthlyCap', 'UNKNOWN_FIELD'],
      [{ smsAllowedTypes: ['diary_posted'] }, 'smsAllowedTypes', 'INVALID_VALUE'],
      [{ smsAllowedTypes: ['absence_alert', 'absence_alert'] }, 'smsAllowedTypes', 'INVALID_VALUE'],
      [{ lateCountsAs: 'absent_after_cutoff' }, 'lateCutoffTime', 'INVALID_VALUE'],
      [{ lateCountsAs: 'absent_after_cutoff', lateCutoffTime: null }, 'lateCutoffTime', 'INVALID_VALUE'],
    ];
    for (const [body, path, code] of refused) {
      const res = await patch(cookie, body).expect(422);
      const fields = (res.body as { error: { details: { fields: { path: string; code: string }[] } } }).error.details.fields;
      expect(fields.map((f) => [f.path.replace(/\[\d+\]$/, ''), f.code])).toContainEqual([path, code]);
    }
    // With a cut-off already stored, switching the rule needs no cut-off in the same patch; clearing it then is refused.
    await patch(cookie, { lateCutoffTime: '08:45' }).expect(200);
    await patch(cookie, { lateCountsAs: 'absent_after_cutoff' }).expect(200);
    await patch(cookie, { lateCutoffTime: null }).expect(422);
    expect(await db().auditLog.count({ where: { schoolId: school.id, action: 'school_settings.updated' } })).toBe(2);
  });
});
