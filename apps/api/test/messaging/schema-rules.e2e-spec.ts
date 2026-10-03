// The hand-written rules of the Phase 2 messaging migration (20261003183118_phase2_messaging),
// driven with raw SQL. Every statement runs inside one transaction that is rolled back, each
// behind its own savepoint, so nothing here changes a committed row even if a rule were missing.
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createGuardian, type TestGuardian } from '../support/students';

describe('messaging schema rules (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let school: TestSchool;
  let other: TestSchool;
  let guardian: TestGuardian;
  let staffId: bigint;
  let seq = 0;

  /** The constraint a statement is refused by (null when it succeeds), then undone either way. */
  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    const savepoint = `rule_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      await pg.query(sql, params);
      return null;
    } catch (error) {
      return (error as DatabaseError).constraint ?? (error as Error).message;
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  };

  /** Runs a statement that must succeed and keeps its effect until the final rollback. */
  const run = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> =>
    (await pg.query<T>(sql, params)).rows[0] as T;

  const insertMessage = (schoolId: bigint, guardianId: bigint, subjectId = 1) =>
    `INSERT INTO messages (school_id, type, priority, subject_type, subject_id, guardian_id, body, channel_plan)
     VALUES (${schoolId}, 'absence_alert', 'urgent', 'attendance_alert', ${subjectId}, ${guardianId},
             'School: absent today', ARRAY['whatsapp', 'sms']::message_channel[]) RETURNING id`;

  const insertDelivery = (messageId: bigint, extra = '', values = '') =>
    `INSERT INTO message_deliveries (school_id, message_id, channel, attempt, status${extra})
     VALUES (${school.id}, ${messageId}, 'sms', 1, 'accepted'${values}) RETURNING id`;

  beforeAll(async () => {
    school = await createSchool();
    other = await createSchool();
    guardian = await createGuardian(db, school);
    staffId = (await createSchoolUser(db, school, { systemRole: 'teacher' })).staffId;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
  });

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  it('R107: one message per person per subject; exactly one person; no identity number in the body', async () => {
    await run(insertMessage(school.id, guardian.id, 7));
    expect(await refusedBy(insertMessage(school.id, guardian.id, 7))).toBe('messages_subject_guardian_key');
    expect(await refusedBy(insertMessage(school.id, guardian.id, 8))).toBeNull();
    expect(
      await refusedBy(
        `INSERT INTO messages (school_id, type, priority, subject_type, subject_id, guardian_id, staff_id, body, channel_plan)
         VALUES ($1, 'holiday_notice', 'normal', 'holiday', 1, $2, $3, 'x', '{}')`,
        [school.id, guardian.id, staffId],
      ),
    ).toBe('messages_recipient_check');
    expect(
      await refusedBy(
        `INSERT INTO messages (school_id, type, priority, subject_type, subject_id, guardian_id, body, channel_plan)
         VALUES ($1, 'holiday_notice', 'normal', 'holiday', 2, $2, 'CNIC 3520212345671', '{}')`,
        [school.id, guardian.id],
      ),
    ).toBe('messages_body_no_id_check');
  });

  it('a message’s content is frozen; claimed_at is required while sending', async () => {
    const { id } = await run<{ id: bigint }>(insertMessage(school.id, guardian.id, 20));
    expect(await refusedBy(`UPDATE messages SET body = 'changed' WHERE id = $1`, [id])).toBe(
      'messages_body_immutable',
    );
    expect(await refusedBy(`UPDATE messages SET status = 'sending' WHERE id = $1`, [id])).toBe(
      'messages_claimed_check',
    );
    expect(
      await refusedBy(`UPDATE messages SET status = 'sending', claimed_at = now() WHERE id = $1`, [id]),
    ).toBeNull();
  });

  it('R108: a delivery moves only forward, and poll_ref only to NULL', async () => {
    const { id: messageId } = await run<{ id: bigint }>(insertMessage(school.id, guardian.id, 30));
    const { id } = await run<{ id: bigint }>(
      insertDelivery(messageId, ', poll_ref', `, 'v1:k:iv:tag:ct'`),
    );
    // Not forward, or not a column that may move.
    expect(await refusedBy(`UPDATE message_deliveries SET status = 'suppressed', suppressed_reason = 'cap_reached' WHERE id = $1`, [id])).toBe(
      'message_deliveries_forward_only',
    );
    expect(await refusedBy(`UPDATE message_deliveries SET channel = 'whatsapp' WHERE id = $1`, [id])).toBe(
      'message_deliveries_forward_only',
    );
    expect(await refusedBy(`UPDATE message_deliveries SET poll_ref = 'v1:other' WHERE id = $1`, [id])).toBe(
      'message_deliveries_forward_only',
    );
    // A final status must clear the pull reference.
    expect(
      await refusedBy(`UPDATE message_deliveries SET status = 'delivered', delivered_at = now() WHERE id = $1`, [id]),
    ).toBe('message_deliveries_poll_ref_check');
    await run(
      `UPDATE message_deliveries SET status = 'delivered', delivered_at = now(), poll_ref = NULL WHERE id = $1 RETURNING id`,
      [id],
    );
    // Delivered is final; a replayed report that changes nothing passes.
    expect(
      await refusedBy(`UPDATE message_deliveries SET status = 'failed', failed_at = now(), delivered_at = NULL WHERE id = $1`, [id]),
    ).toBe('message_deliveries_forward_only');
    expect(await refusedBy(`UPDATE message_deliveries SET status = 'delivered' WHERE id = $1`, [id])).toBeNull();
  });

  it('a delivery is unique per attempt; a provider reference is unique across schools; recipients are masked', async () => {
    const { id: messageId } = await run<{ id: bigint }>(insertMessage(school.id, guardian.id, 40));
    await run(insertDelivery(messageId));
    expect(await refusedBy(insertDelivery(messageId))).toBe('message_deliveries_attempt_key');
    const ref = 'a'.repeat(64);
    await run(
      `INSERT INTO message_deliveries (school_id, message_id, channel, attempt, status, provider_ref_hash)
       VALUES ($1, $2, 'whatsapp', 1, 'accepted', $3) RETURNING id`,
      [school.id, messageId, ref],
    );
    const otherGuardian = await createGuardian(db, other);
    const { id: otherMessage } = await run<{ id: bigint }>(insertMessage(other.id, otherGuardian.id, 40));
    expect(
      await refusedBy(
        `INSERT INTO message_deliveries (school_id, message_id, channel, attempt, status, provider_ref_hash)
         VALUES ($1, $2, 'whatsapp', 1, 'accepted', $3)`,
        [other.id, otherMessage, ref],
      ),
    ).toBe('message_deliveries_provider_ref_key');
    expect(
      await refusedBy(
        `INSERT INTO message_deliveries (school_id, message_id, channel, attempt, status, to_masked)
         VALUES ($1, $2, 'sms', 2, 'accepted', '+923001234567')`,
        [school.id, messageId],
      ),
    ).toBe('message_deliveries_to_masked_no_id_check');
    expect(
      await refusedBy(
        `INSERT INTO message_deliveries (school_id, message_id, channel, attempt, status, to_masked)
         VALUES ($1, $2, 'sms', 2, 'accepted', '+9230*****67')`,
        [school.id, messageId],
      ),
    ).toBeNull();
  });

  it('whatsapp_numbers: one live number per school; disabled is final; the provider is frozen', async () => {
    const live = await createSchool();
    const insert = `INSERT INTO whatsapp_numbers (school_id, phone, provider) VALUES ($1, '+923001112222', 'waha') RETURNING id`;
    const { id } = await run<{ id: bigint }>(insert, [live.id]);
    expect(await refusedBy(insert, [live.id])).toBe('whatsapp_numbers_school_id_live_key');
    expect(await refusedBy(`UPDATE whatsapp_numbers SET provider = 'cloud_api' WHERE id = $1`, [id])).toBe(
      'whatsapp_numbers_provider_immutable',
    );
    const user = await createSchoolUser(db, live, { systemRole: 'principal' });
    await run(
      `UPDATE whatsapp_numbers SET status = 'disabled', disabled_at = now(), disabled_by = $2,
              disabled_reason = 'SIM lost' WHERE id = $1 RETURNING id`,
      [id, user.userId],
    );
    expect(await refusedBy(`UPDATE whatsapp_numbers SET status = 'connected' WHERE id = $1`, [id])).toBe(
      'whatsapp_numbers_status_frozen',
    );
    // A replacement number is a new row.
    expect(await refusedBy(insert, [live.id])).toBeNull();
  });

  it('platform_settings: one seeded row (waha, sendpk), never a second', async () => {
    const { rows } = await pg.query<{ id: string; w: string; s: string }>(
      `SELECT id, default_whatsapp_provider AS w, default_sms_provider AS s FROM platform_settings`,
    );
    expect(rows).toEqual([{ id: '1', w: 'waha', s: 'sendpk' }]);
    expect(await refusedBy(`INSERT INTO platform_settings (id) VALUES (2)`)).toBe('platform_settings_one_row_check');
  });

  it('school_settings: Phase 2 defaults on existing rows; only SMS-eligible types; never seven days off', async () => {
    const settings = await run<{ id: bigint }>(
      `INSERT INTO school_settings (school_id) VALUES ($1) RETURNING id`,
      [school.id],
    );
    const { rows } = await pg.query(
      `SELECT periods_per_day, weekly_off_days, attendance_amend_window_days,
              register_deadline_time::text AS deadline, absence_alert_time::text AS alert,
              late_counts_as, leave_counts_as, sms_allowed_types::text[] AS sms,
              remark_default_visibility, remark_notify_guardians
       FROM school_settings WHERE id = $1`,
      [settings.id],
    );
    expect(rows[0]).toEqual({
      periods_per_day: 8,
      weekly_off_days: [0],
      attendance_amend_window_days: 3,
      deadline: '10:00:00',
      alert: '09:30:00',
      late_counts_as: 'present',
      leave_counts_as: 'excused',
      sms: ['absence_alert', 'late_advice', 'attendance_corrected', 'announcement_urgent', 'holiday_notice'],
      remark_default_visibility: 'guardian',
      remark_notify_guardians: false,
    });
    const update = (set: string) => refusedBy(`UPDATE school_settings SET ${set} WHERE id = $1`, [settings.id]);
    expect(await update(`sms_allowed_types = ARRAY['diary_posted']::message_type[]`)).toBe(
      'school_settings_sms_allowed_types_check',
    );
    expect(await update(`sms_allowed_types = ARRAY['announcement_normal']::message_type[]`)).toBeNull();
    expect(await update(`weekly_off_days = ARRAY[0,1,2,3,4,5,6]::smallint[]`)).toBe(
      'school_settings_weekly_off_days_check',
    );
    expect(await update(`weekly_off_days = '{}'`)).toBeNull();
    expect(await update(`late_counts_as = 'absent_after_cutoff'`)).toBe('school_settings_late_cutoff_time_check');
    expect(await update(`late_counts_as = 'absent_after_cutoff', late_cutoff_time = '08:15'`)).toBeNull();
  });
});
