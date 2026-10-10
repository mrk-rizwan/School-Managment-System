// Phase 5 wave S in the database (migration 20261010090000_wave_s_events_contracts;
// phase-5-extended.md §3.2 "Events", "Contracts", R310-R321): every CHECK, partial unique,
// trigger and composite foreign key of events, event_sections, event_duties, event_participation,
// staff_contracts and expenses.event_id, written directly. Each statement is raw SQL inside one
// transaction that is rolled back, behind its own savepoint, so nothing here changes or removes a
// row even if a guard were missing (an exemption in guardrails/no-truncate.spec.ts). The last block
// maps a few refusals through the error mapper with committed rows of a school of its own.
import { ErrorCode } from '@asms/shared';
import { Client, type DatabaseError } from 'pg';
import { mapDatabaseError } from '../../src/common/errors/prisma-errors';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import { createAcademicYear, createClass, createSection, createStudent, day, enrol } from '../support/students';

const TABLES = ['events', 'event_sections', 'event_duties', 'event_participation', 'staff_contracts'];
const ID = '4210112345671';

describe('wave S schema: events, contracts and the expense tag (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let school: TestSchool;
  let schoolId: bigint;
  let otherSchoolId: bigint;
  let principal: { userId: bigint; staffId: bigint };
  let teacher: { userId: bigint; staffId: bigint };
  let yearId: bigint;
  let classId: bigint;
  let sectionA: bigint;
  let sectionB: bigint;
  let otherYearSection: { id: bigint; classId: bigint; yearId: bigint };
  let student1: bigint;
  let student2: bigint;
  let enrolment1: bigint;
  let enrolment2: bigint;
  let otherYearEnrolment1: bigint;
  let eventHeadId: bigint;

  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    const savepoint = `guard_${seq++}`;
    await pg.query(`SAVEPOINT ${savepoint}`);
    try {
      await pg.query(sql, params);
      return null;
    } catch (error) {
      const e = error as DatabaseError;
      return e.constraint ?? e.detail?.replace(/^constraint: /, '') ?? e.message;
    } finally {
      await pg.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    }
  };

  const truncateRefused = async (table: string): Promise<string | null> => {
    const refusal = await refusedBy(`TRUNCATE ${table}`);
    if (refusal === null || !/lock timeout/i.test(refusal)) return refusal;
    const guard = await pg.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND (tgtype & 32) <> 0 AND NOT tgisinternal`,
      [table],
    );
    return (guard.rowCount ?? 0) > 0 ? `${table}: guarded (busy)` : null;
  };

  const one = async (sql: string, params: unknown[] = []): Promise<bigint> => {
    const { rows } = await pg.query<{ id: string }>(sql, params);
    return BigInt(rows[0]!.id);
  };

  /** A draft event inside the open transaction (kept until the final rollback). */
  const draftEvent = async (o: { charge?: number | null; startsAt?: string } = {}): Promise<bigint> =>
    one(
      `INSERT INTO events (school_id, academic_year_id, type, title, starts_at, ends_at, venue, charge_amount, created_by)
       VALUES ($1, $2, 'ptm', 'Parents meeting', $3::timestamptz, $3::timestamptz + interval '2 hours', 'School hall', $4, $5)
       RETURNING id`,
      [schoolId, yearId, o.startsAt ?? '2026-05-10T09:00:00+05:00', o.charge ?? null, principal.userId],
    );

  const announcement = (): Promise<bigint> =>
    one(
      `INSERT INTO announcements (school_id, title, body, category, priority, created_by)
       VALUES ($1, 'Event notice', 'Details follow.', 'event', 'normal', $2) RETURNING id`,
      [schoolId, principal.userId],
    );

  const campaign = (year = yearId): Promise<bigint> =>
    one(
      `INSERT INTO charge_campaigns (school_id, name, academic_year_id, fee_head_id, amount, due_on, created_by)
       VALUES ($1, 'Trip fee', $2, $3, 500, '2026-05-09', $4) RETURNING id`,
      [schoolId, year, eventHeadId, principal.userId],
    );

  const addSection = (eventId: bigint, section = sectionA): Promise<bigint> =>
    one(
      `INSERT INTO event_sections (school_id, event_id, section_id, class_id, academic_year_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [schoolId, eventId, section, classId, yearId],
    );

  /** A published event (with a section and an invitation; a campaign when charged). */
  const publishedEvent = async (charge: number | null = null): Promise<bigint> => {
    const id = await draftEvent({ charge });
    await addSection(id);
    const invite = await announcement();
    const campaignId = charge === null ? null : await campaign();
    await pg.query(
      `UPDATE events SET status = 'published', announcement_id = $2, campaign_id = $3 WHERE id = $1`,
      [id, invite, campaignId],
    );
    return id;
  };

  const complete = (eventId: bigint) =>
    pg.query(`UPDATE events SET status = 'completed', completed_at = now() WHERE id = $1`, [eventId]);

  beforeAll(async () => {
    school = await createSchool();
    schoolId = school.id;
    otherSchoolId = (await createSchool()).id;
    principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    yearId = year.id;
    const klass = await createClass(db, school, year);
    classId = klass.id;
    const a = await createSection(db, school, klass);
    sectionA = a.id;
    sectionB = (await createSection(db, school, klass)).id;
    const nextYear = await createAcademicYear(db, school, { startsOn: '2027-04-01', endsOn: '2028-03-31' });
    const nextClass = await createClass(db, school, nextYear);
    const nextSection = await createSection(db, school, nextClass);
    otherYearSection = { id: nextSection.id, classId: nextClass.id, yearId: nextYear.id };
    const s1 = await createStudent(db, school, { admittedOn: '2026-04-01' });
    const s2 = await createStudent(db, school, { admittedOn: '2026-04-01' });
    student1 = s1.id;
    student2 = s2.id;
    enrolment1 = (await enrol(db, school, s1, a, { startedOn: '2026-04-01' })).id;
    enrolment2 = (await enrol(db, school, s2, a, { startedOn: '2026-04-01' })).id;
    // student1 also in the next year (ended, as one live enrolment per student allows).
    otherYearEnrolment1 = (
      await enrol(db, school, s1, nextSection, { status: 'left', startedOn: '2027-04-01', endedOn: '2027-04-30' })
    ).id;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL lock_timeout = '5s'`);
    await pg.query('SELECT asms_seed_school_finance($1)', [schoolId]);
    eventHeadId = await one(`SELECT id FROM fee_heads WHERE school_id = $1 AND category = 'event'`, [schoolId]);
  });

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  // ---------------------------------------------------------------------------- events

  describe('events (R310, R313, R316)', () => {
    it('R316: an event is born draft', async () => {
      expect(await refusedBy(
        `INSERT INTO events (school_id, academic_year_id, type, title, starts_at, ends_at, venue, status, created_by)
         VALUES ($1, $2, 'trip', 'Zoo trip', '2026-05-10T09:00:00+05:00', '2026-05-10T13:00:00+05:00', 'Zoo', 'published', $3)`,
        [schoolId, yearId, principal.userId],
      )).toBe('events_born_draft');
    });

    it('A4: the date in school time lies inside the academic year, on insert and on a draft edit', async () => {
      expect(await refusedBy(
        `INSERT INTO events (school_id, academic_year_id, type, title, starts_at, ends_at, venue, created_by)
         VALUES ($1, $2, 'trip', 'Zoo trip', '2026-03-31T09:00:00+05:00', '2026-03-31T13:00:00+05:00', 'Zoo', $3)`,
        [schoolId, yearId, principal.userId],
      )).toBe('events_in_year');
      // 2026-03-31 20:00 UTC is 1 April in Karachi: inside the year.
      const id = await draftEvent({ startsAt: '2026-03-31T20:00:00Z' });
      expect(await refusedBy(
        `UPDATE events SET starts_at = '2027-04-02T09:00:00+05:00', ends_at = '2027-04-02T10:00:00+05:00' WHERE id = $1`,
        [id],
      )).toBe('events_in_year');
    });

    it('text, times and the draft charge are checked', async () => {
      const id = await draftEvent();
      const cases: [string, unknown[], string][] = [
        [`UPDATE events SET ends_at = starts_at - interval '1 minute' WHERE id = $1`, [id], 'events_dates_check'],
        [`UPDATE events SET title = ' Meeting' WHERE id = $1`, [id], 'events_title_check'],
        [`UPDATE events SET title = $2 WHERE id = $1`, [id, `Bring ${ID}`], 'events_title_no_id_check'],
        [`UPDATE events SET venue = '' WHERE id = $1`, [id], 'events_venue_check'],
        [`UPDATE events SET venue = $2 WHERE id = $1`, [id, ID], 'events_venue_no_id_check'],
        [`UPDATE events SET details = '  ' WHERE id = $1`, [id], 'events_details_check'],
        [`UPDATE events SET details = $2 WHERE id = $1`, [id, '42101-1234567-1'], 'events_details_no_id_check'],
        [`UPDATE events SET charge_amount = 0 WHERE id = $1`, [id], 'events_charge_check'],
        [`UPDATE events SET charge_due_on = '2026-05-09' WHERE id = $1`, [id], 'events_charge_check'],
      ];
      for (const [sql, params, constraint] of cases) expect(await refusedBy(sql, params)).toBe(constraint);
      expect(await refusedBy(`UPDATE events SET details = 'Bring lunch', charge_amount = 500, charge_due_on = '2026-05-09' WHERE id = $1`, [id])).toBeNull();
    });

    it('R310: publish needs a section, the invitation, and the campaign when charged; a draft has neither', async () => {
      const id = await draftEvent({ charge: 300 });
      const invite = await announcement();
      const campaignId = await campaign();
      expect(await refusedBy(`UPDATE events SET campaign_id = $2 WHERE id = $1`, [id, campaignId])).toBe('events_campaign_check');
      expect(await refusedBy(`UPDATE events SET announcement_id = $2 WHERE id = $1`, [id, invite])).toBe('events_announcement_check');
      expect(await refusedBy(
        `UPDATE events SET status = 'published', announcement_id = $2, campaign_id = $3 WHERE id = $1`,
        [id, invite, campaignId],
      )).toBe('events_has_sections');
      await addSection(id);
      expect(await refusedBy(`UPDATE events SET status = 'published', campaign_id = $2 WHERE id = $1`, [id, campaignId])).toBe('events_announcement_check');
      expect(await refusedBy(`UPDATE events SET status = 'published', announcement_id = $2 WHERE id = $1`, [id, invite])).toBe('events_campaign_check');
      expect(await refusedBy(
        `UPDATE events SET status = 'published', announcement_id = $2, campaign_id = $3 WHERE id = $1`,
        [id, invite, campaignId],
      )).toBeNull();
    });

    it('R310: the campaign is of the event year, and serves one event; an uncharged event has none', async () => {
      const otherYearCampaign = await campaign(otherYearSection.yearId);
      const id = await draftEvent({ charge: 300 });
      await addSection(id);
      expect(await refusedBy(
        `UPDATE events SET status = 'published', announcement_id = $2, campaign_id = $3 WHERE id = $1`,
        [id, await announcement(), otherYearCampaign],
      )).toBe('events_campaign_id_fkey');
      const taken = await campaign();
      const first = await draftEvent({ charge: 300 });
      await addSection(first);
      await pg.query(`UPDATE events SET status = 'published', announcement_id = $2, campaign_id = $3 WHERE id = $1`, [first, await announcement(), taken]);
      expect(await refusedBy(
        `UPDATE events SET status = 'published', announcement_id = $2, campaign_id = $3 WHERE id = $1`,
        [id, await announcement(), taken],
      )).toBe('events_school_id_campaign_id_key');
      const free = await draftEvent();
      await addSection(free);
      expect(await refusedBy(
        `UPDATE events SET status = 'published', announcement_id = $2, campaign_id = $3 WHERE id = $1`,
        [free, await announcement(), await campaign()],
      )).toBe('events_campaign_check');
    });

    it('R316: content is frozen once published; the campaign and invitation are set once', async () => {
      const id = await publishedEvent(400);
      for (const [column, value] of [
        ['title', 'New title'],
        ['venue', 'Lawn'],
        ['type', 'trip'],
        ['details', 'Changed'],
        ['charge_amount', '450'],
        ['starts_at', '2026-05-10T10:00:00+05:00'],
      ] as const) {
        expect(await refusedBy(`UPDATE events SET ${column} = $2 WHERE id = $1`, [id, value])).toBe(`events_${column}_frozen`);
      }
      expect(await refusedBy(`UPDATE events SET campaign_id = $2 WHERE id = $1`, [id, await campaign()])).toBe('events_campaign_id_frozen');
      expect(await refusedBy(`UPDATE events SET announcement_id = $2 WHERE id = $1`, [id, await announcement()])).toBe('events_announcement_id_frozen');
      expect(await refusedBy(`UPDATE events SET academic_year_id = $2 WHERE id = $1`, [id, otherYearSection.yearId])).toBe('events_academic_year_id_immutable');
      expect(await refusedBy(`UPDATE events SET school_id = $2 WHERE id = $1`, [id, otherSchoolId])).toBe('events_school_id_immutable');
    });

    it('R316: status edges; completed and cancelled are final', async () => {
      const draft = await draftEvent();
      expect(await refusedBy(`UPDATE events SET status = 'completed', completed_at = now() WHERE id = $1`, [draft])).toBe('events_status_transition');
      const id = await publishedEvent();
      expect(await refusedBy(`UPDATE events SET status = 'draft' WHERE id = $1`, [id])).toBe('events_status_transition');
      expect(await refusedBy(`UPDATE events SET status = 'completed' WHERE id = $1`, [id])).toBe('events_completed_check');
      await complete(id);
      expect(await refusedBy(
        `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Rain', cancel_announcement_id = $3 WHERE id = $1`,
        [id, principal.userId, await announcement()],
      )).toBe('events_status_transition');
      expect(await refusedBy(`UPDATE events SET completed_at = now() + interval '1 day' WHERE id = $1`, [id])).toBe('events_completed_at_frozen');
    });

    it('R313: a published event cancels with a cancellation notice, a draft without one; the trio is set once', async () => {
      const draft = await draftEvent();
      expect(await refusedBy(
        `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Rain', cancel_announcement_id = $3 WHERE id = $1`,
        [draft, principal.userId, await announcement()],
      )).toBe('events_cancel_announcement_check');
      expect(await refusedBy(`UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2 WHERE id = $1`, [draft, principal.userId])).toBe('events_cancelled_check');
      expect(await refusedBy(
        `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
        [draft, principal.userId, `Ask ${ID}`],
      )).toBe('events_cancel_reason_no_id_check');
      expect(await refusedBy(
        `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Rain' WHERE id = $1`,
        [draft, principal.userId],
      )).toBeNull();

      const id = await publishedEvent(200);
      const invite = (await pg.query<{ a: string }>(`SELECT announcement_id AS a FROM events WHERE id = $1`, [id])).rows[0]!.a;
      const cancelSql = `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Rain', cancel_announcement_id = $3 WHERE id = $1`;
      expect(await refusedBy(`UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Rain' WHERE id = $1`, [id, principal.userId])).toBe('events_cancel_announcement_check');
      expect(await refusedBy(cancelSql, [id, principal.userId, invite])).toBe('events_cancel_announcement_check');
      const notice = await announcement();
      await pg.query(cancelSql, [id, principal.userId, notice]);
      expect(await refusedBy(`UPDATE events SET cancel_reason = 'Storm' WHERE id = $1`, [id])).toBe('events_cancel_reason_frozen');
      expect(await refusedBy(`UPDATE events SET cancel_announcement_id = $2 WHERE id = $1`, [id, await announcement()])).toBe('events_cancel_announcement_id_frozen');
      expect(await refusedBy(`UPDATE events SET status = 'published' WHERE id = $1`, [id])).toBe('events_status_transition');
    });
  });

  // ---------------------------------------------------------------------------- event_sections

  describe('event_sections (R310)', () => {
    it('a draft section is added, replaced and deleted; a section of another year or twice is refused', async () => {
      const id = await draftEvent();
      const row = await addSection(id);
      expect(await refusedBy(
        `INSERT INTO event_sections (school_id, event_id, section_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4, $5)`,
        [schoolId, id, sectionA, classId, yearId],
      )).toBe('event_sections_event_section_key');
      expect(await refusedBy(
        `INSERT INTO event_sections (school_id, event_id, section_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4, $5)`,
        [schoolId, id, otherYearSection.id, otherYearSection.classId, yearId],
      )).toBe('event_sections_class_id_fkey');
      expect(await refusedBy(
        `INSERT INTO event_sections (school_id, event_id, section_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4, $5)`,
        [schoolId, id, otherYearSection.id, otherYearSection.classId, otherYearSection.yearId],
      )).toBe('event_sections_event_id_fkey');
      expect(await refusedBy(`UPDATE event_sections SET section_id = $2 WHERE id = $1`, [row, sectionB])).toBe('event_sections_section_id_immutable');
      expect(await refusedBy(`DELETE FROM event_sections WHERE id = $1`, [row])).toBeNull();
    });

    it('once the event leaves draft its sections are history: no insert, update or delete', async () => {
      const id = await publishedEvent();
      const row = await one(`SELECT id FROM event_sections WHERE event_id = $1`, [id]);
      expect(await refusedBy(
        `INSERT INTO event_sections (school_id, event_id, section_id, class_id, academic_year_id) VALUES ($1, $2, $3, $4, $5)`,
        [schoolId, id, sectionB, classId, yearId],
      )).toBe('event_sections_draft_only');
      expect(await refusedBy(`DELETE FROM event_sections WHERE id = $1`, [row])).toBe('event_sections_draft_only');
      expect(await refusedBy(`UPDATE event_sections SET created_at = created_at WHERE id = $1`, [row])).toBe('event_sections_draft_only');
    });
  });

  // ---------------------------------------------------------------------------- event_duties

  describe('event_duties (R311)', () => {
    const dutySql = `INSERT INTO event_duties (school_id, event_id, staff_id, duty, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
    const duty = (eventId: bigint, kind = 'supervision', note: string | null = null) =>
      one(dutySql, [schoolId, eventId, teacher.staffId, kind, note, principal.userId]);
    const endSql = `UPDATE event_duties SET ended_at = now(), ended_by = $2, end_reason = $3 WHERE id = $1`;

    it('one live duty of a kind per staff member; ended, it may be given again; born live', async () => {
      const id = await draftEvent();
      const first = await duty(id);
      expect(await refusedBy(dutySql, [schoolId, id, teacher.staffId, 'supervision', null, principal.userId])).toBe('event_duties_live_key');
      expect(await duty(id, 'collection')).toBeGreaterThan(0n);
      await pg.query(endSql, [first, principal.userId, 'Swapped']);
      expect(await duty(id)).toBeGreaterThan(0n);
      expect(await refusedBy(
        `INSERT INTO event_duties (school_id, event_id, staff_id, duty, created_by, ended_at, ended_by, end_reason)
         VALUES ($1, $2, $3, 'other', $4, now(), $4, 'Never')`,
        [schoolId, id, teacher.staffId, principal.userId],
      )).toBe('event_duties_born_live');
    });

    it('text is checked; a duty is never edited; the end trio is set together and once', async () => {
      const id = await draftEvent();
      expect(await refusedBy(dutySql, [schoolId, id, teacher.staffId, 'other', ' x', principal.userId])).toBe('event_duties_note_check');
      expect(await refusedBy(dutySql, [schoolId, id, teacher.staffId, 'other', ID, principal.userId])).toBe('event_duties_note_no_id_check');
      const row = await duty(id, 'registration', 'Front gate');
      expect(await refusedBy(`UPDATE event_duties SET duty = 'other' WHERE id = $1`, [row])).toBe('event_duties_duty_immutable');
      expect(await refusedBy(`UPDATE event_duties SET note = 'Back gate' WHERE id = $1`, [row])).toBe('event_duties_note_immutable');
      expect(await refusedBy(`UPDATE event_duties SET ended_at = now() WHERE id = $1`, [row])).toBe('event_duties_ended_check');
      expect(await refusedBy(endSql, [row, principal.userId, ID])).toBe('event_duties_end_reason_no_id_check');
      await pg.query(endSql, [row, principal.userId, 'Not needed']);
      expect(await refusedBy(`UPDATE event_duties SET end_reason = 'Other' WHERE id = $1`, [row])).toBe('event_duties_end_reason_frozen');
      expect(await refusedBy(`DELETE FROM event_duties WHERE id = $1`, [row])).toBe('event_duties_no_delete');
    });

    it('duties change only while the event is draft or published', async () => {
      const id = await publishedEvent();
      const row = await duty(id);
      await complete(id);
      expect(await refusedBy(dutySql, [schoolId, id, teacher.staffId, 'other', null, principal.userId])).toBe('event_duties_event_open');
      expect(await refusedBy(endSql, [row, principal.userId, 'Late'])).toBe('event_duties_event_open');
    });
  });

  // ---------------------------------------------------------------------------- event_participation

  describe('event_participation (R312)', () => {
    const recordSql = `INSERT INTO event_participation (school_id, event_id, academic_year_id, student_id, enrolment_id, status, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;
    const record = (eventId: bigint, student: bigint, enrolment: bigint, status = 'attended', year = yearId) =>
      refusedBy(recordSql, [schoolId, eventId, year, student, enrolment, status, teacher.userId]);

    it('recorded only while published, edited in place, frozen at completion', async () => {
      const draft = await draftEvent();
      expect(await record(draft, student1, enrolment1)).toBe('event_participation_event_published');
      const id = await publishedEvent();
      const row = await one(recordSql, [schoolId, id, yearId, student1, enrolment1, 'absent', teacher.userId]);
      expect(await refusedBy(`UPDATE event_participation SET status = 'attended', recorded_by = $2, recorded_at = now() WHERE id = $1`, [row, principal.userId])).toBeNull();
      expect(await record(id, student1, enrolment1)).toBe('event_participation_event_student_key');
      expect(await refusedBy(`UPDATE event_participation SET enrolment_id = $2, student_id = $3 WHERE id = $1`, [row, enrolment2, student2])).toBe('event_participation_student_id_immutable');
      expect(await refusedBy(`DELETE FROM event_participation WHERE id = $1`, [row])).toBe('event_participation_no_delete');
      await complete(id);
      expect(await refusedBy(`UPDATE event_participation SET status = 'excused' WHERE id = $1`, [row])).toBe('event_participation_event_published');
      expect(await record(id, student2, enrolment2)).toBe('event_participation_event_published');
    });

    it('the enrolment names the same student, of the event year', async () => {
      const id = await publishedEvent();
      expect(await record(id, student2, enrolment1)).toBe('event_participation_enrolment_id_fkey');
      expect(await record(id, student1, otherYearEnrolment1)).toBe('event_participation_enrolment_id_fkey');
      expect(await record(id, student1, otherYearEnrolment1, 'attended', otherYearSection.yearId)).toBe('event_participation_event_id_fkey');
    });
  });

  // ---------------------------------------------------------------------------- expenses.event_id

  describe('expenses.event_id (R314)', () => {
    const expense = (status = 'recorded') =>
      one(
        `INSERT INTO expenses (school_id, expense_no, category, amount, spent_on, description, method, status, recorded_by,
                               voided_at, voided_by, void_reason)
         VALUES ($1, (SELECT coalesce(max(expense_no), 0) + 1 FROM expenses WHERE school_id = $1), 'other', 900, '2026-05-10',
                 'Bus hire', 'cash', $2::expense_status, $3,
                 CASE WHEN $2 = 'voided' THEN now() END, CASE WHEN $2 = 'voided' THEN $3::bigint END,
                 CASE WHEN $2 = 'voided' THEN 'Duplicate' END)
         RETURNING id`,
        [schoolId, status, teacher.userId],
      );
    const tag = (expenseId: bigint, eventId: bigint | null) =>
      refusedBy(`UPDATE expenses SET event_id = $2 WHERE id = $1`, [expenseId, eventId]);

    it('tagged once to a published or completed event; never moved or cleared', async () => {
      const draft = await draftEvent();
      const published = await publishedEvent();
      const completed = await publishedEvent();
      await complete(completed);
      const row = await expense();
      expect(await tag(row, draft)).toBe('expenses_event_tag_event_status');
      expect(await tag(row, published)).toBeNull();
      await pg.query(`UPDATE expenses SET event_id = $2 WHERE id = $1`, [row, published]);
      expect(await tag(row, completed)).toBe('expenses_event_id_frozen');
      expect(await tag(row, null)).toBe('expenses_event_id_frozen');
      expect(await tag(await expense(), completed)).toBeNull();
    });

    it('a voided expense is not tagged; a cancelled event takes no tag; another school is refused', async () => {
      const published = await publishedEvent();
      expect(await tag(await expense('voided'), published)).toBe('expenses_event_tag_voided');
      const cancelled = await draftEvent();
      await pg.query(
        `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = 'Rain' WHERE id = $1`,
        [cancelled, principal.userId],
      );
      expect(await tag(await expense(), cancelled)).toBe('expenses_event_tag_event_status');
      const row = await expense();
      expect(await refusedBy(`UPDATE expenses SET event_id = $2, school_id = $3 WHERE id = $1`, [row, published, otherSchoolId])).not.toBeNull();
      // A tagged expense still moves through its own lifecycle (a late bill is approved after tagging).
      await pg.query(`UPDATE expenses SET event_id = $2 WHERE id = $1`, [row, published]);
      expect(await refusedBy(`UPDATE expenses SET status = 'approved', decided_at = now(), decided_by = $2 WHERE id = $1`, [row, principal.userId])).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------- staff_contracts

  describe('staff_contracts (R318-R321)', () => {
    const contractSql = `INSERT INTO staff_contracts (school_id, staff_id, type, starts_on, ends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
    const contract = (staffId: bigint, type: string, startsOn: string, endsOn: string | null) =>
      refusedBy(contractSql, [schoolId, staffId, type, startsOn, endsOn, principal.userId]);
    const endSql = `UPDATE staff_contracts SET ended_at = now(), ended_by = $2, end_reason = $3, ended_on = $4 WHERE id = $1`;

    it('R318: permanent has no end, any other type has one, never before the start', async () => {
      expect(await contract(teacher.staffId, 'permanent', '2026-04-01', '2027-03-31')).toBe('staff_contracts_type_end_check');
      expect(await contract(teacher.staffId, 'fixed_term', '2026-04-01', null)).toBe('staff_contracts_type_end_check');
      expect(await contract(teacher.staffId, 'probation', '2026-04-01', '2026-03-31')).toBe('staff_contracts_dates_check');
    });

    it('R318: one live contract per staff member; ending it frees the next', async () => {
      const staff = (await createSchoolUser(db, school, { systemRole: 'teacher' })).staffId;
      const first = await one(contractSql, [schoolId, staff, 'probation', '2026-04-01', '2026-06-30', principal.userId]);
      expect(await contract(staff, 'permanent', '2026-07-01', null)).toBe('staff_contracts_live_key');
      expect(await refusedBy(`UPDATE staff_contracts SET ended_at = now(), ended_by = $2 WHERE id = $1`, [first, principal.userId])).toBe('staff_contracts_ended_check');
      expect(await refusedBy(endSql, [first, principal.userId, 'renewed', '2026-03-31'])).toBe('staff_contracts_ended_check');
      expect(await refusedBy(endSql, [first, principal.userId, ID, '2026-06-30'])).toBe('staff_contracts_end_reason_no_id_check');
      await pg.query(endSql, [first, principal.userId, 'renewed', '2026-06-30']);
      expect(await contract(staff, 'permanent', '2026-07-01', null)).toBeNull();
      expect(await refusedBy(`UPDATE staff_contracts SET ended_on = '2026-06-29' WHERE id = $1`, [first])).toBe('staff_contracts_ended_on_frozen');
      expect(await refusedBy(`UPDATE staff_contracts SET end_reason = 'left' WHERE id = $1`, [first])).toBe('staff_contracts_end_reason_frozen');
    });

    it('rule 35: a contract is never edited; the two warnings are set once, only with an end', async () => {
      const staff = (await createSchoolUser(db, school, { systemRole: 'teacher' })).staffId;
      const row = await one(contractSql, [schoolId, staff, 'fixed_term', '2026-04-01', '2027-03-31', principal.userId]);
      expect(await refusedBy(`UPDATE staff_contracts SET ends_on = '2027-06-30' WHERE id = $1`, [row])).toBe('staff_contracts_ends_on_immutable');
      expect(await refusedBy(`UPDATE staff_contracts SET type = 'probation' WHERE id = $1`, [row])).toBe('staff_contracts_type_immutable');
      expect(await refusedBy(`UPDATE staff_contracts SET note = 'Changed' WHERE id = $1`, [row])).toBe('staff_contracts_note_immutable');
      await pg.query(`UPDATE staff_contracts SET warned_30_at = now() WHERE id = $1`, [row]);
      expect(await refusedBy(`UPDATE staff_contracts SET warned_30_at = NULL WHERE id = $1`, [row])).toBe('staff_contracts_warned_30_at_frozen');
      await pg.query(`UPDATE staff_contracts SET warned_7_at = now() WHERE id = $1`, [row]);
      expect(await refusedBy(`UPDATE staff_contracts SET warned_7_at = now() + interval '1 day' WHERE id = $1`, [row])).toBe('staff_contracts_warned_7_at_frozen');
      const permanent = await one(contractSql, [schoolId, principal.staffId, 'permanent', '2026-04-01', null, principal.userId]);
      expect(await refusedBy(`UPDATE staff_contracts SET warned_30_at = now() WHERE id = $1`, [permanent])).toBe('staff_contracts_warned_check');
      expect(await refusedBy(`DELETE FROM staff_contracts WHERE id = $1`, [row])).toBe('staff_contracts_no_delete');
      expect(await refusedBy(`UPDATE staff_contracts SET school_id = $2 WHERE id = $1`, [row, otherSchoolId])).toBe('staff_contracts_school_id_immutable');
    });

    it('R321: the document is a staged key of this school, image or PDF, at most 5 MB; text is checked', async () => {
      const staff = (await createSchoolUser(db, school, { systemRole: 'office_staff' })).staffId;
      const docSql = `INSERT INTO staff_contracts (school_id, staff_id, type, starts_on, document_object_key, document_mime, document_size_bytes, note, created_by)
         VALUES ($1, $2, 'permanent', '2026-04-01', $3, $4, $5, $6, $7)`;
      const key = (school: bigint) => `${school}/01J9Z3K8M2N4P6Q8R0S2T4V6W8.pdf`;
      expect(await refusedBy(docSql, [schoolId, staff, key(otherSchoolId), 'application/pdf', 1000, null, principal.userId])).toBe('staff_contracts_document_check');
      expect(await refusedBy(docSql, [schoolId, staff, key(schoolId), 'text/plain', 1000, null, principal.userId])).toBe('staff_contracts_document_check');
      expect(await refusedBy(docSql, [schoolId, staff, key(schoolId), 'application/pdf', 6_000_000, null, principal.userId])).toBe('staff_contracts_document_check');
      expect(await refusedBy(docSql, [schoolId, staff, key(schoolId), null, null, null, principal.userId])).toBe('staff_contracts_document_check');
      expect(await refusedBy(docSql, [schoolId, staff, null, null, null, ' note', principal.userId])).toBe('staff_contracts_note_check');
      expect(await refusedBy(docSql, [schoolId, staff, null, null, null, `CNIC ${ID}`, principal.userId])).toBe('staff_contracts_note_no_id_check');
      expect(await refusedBy(docSql, [schoolId, staff, key(schoolId), 'application/pdf', 1000, 'Signed copy', principal.userId])).toBeNull();
    });

    it('R321: the structure named is one of the same staff member', async () => {
      const structureSql = `INSERT INTO salary_structures (school_id, staff_id, basic, effective_from, reason, created_by)
         VALUES ($1, $2, 30000, '2026-04-01', 'Starting pay', $3) RETURNING id`;
      const teachersStructure = await one(structureSql, [schoolId, teacher.staffId, principal.userId]);
      const staff = (await createSchoolUser(db, school, { systemRole: 'teacher' })).staffId;
      const linkSql = `INSERT INTO staff_contracts (school_id, staff_id, type, starts_on, salary_structure_id, created_by)
         VALUES ($1, $2, 'permanent', '2026-04-01', $3, $4)`;
      expect(await refusedBy(linkSql, [schoolId, staff, teachersStructure, principal.userId])).toBe('staff_contracts_salary_structure_id_fkey');
      const own = await one(structureSql, [schoolId, staff, principal.userId]);
      expect(await refusedBy(linkSql, [schoolId, staff, own, principal.userId])).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------- rule 4

  it.each(TABLES.filter((t) => t !== 'event_sections'))('rule 4: %s rows are never deleted', async (table) => {
    expect(await refusedBy(`DELETE FROM ${table} WHERE school_id = $1`, [schoolId])).toBe(`${table}_no_delete`);
  });

  it.each(TABLES)('rule 4: %s is never truncated', async (table) => {
    expect(await truncateRefused(table)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------- the error mapper

describe('wave S schema: refusals reach the error mapper', () => {
  // The suite above closed its client; this one opens its own.
  let db: ReturnType<typeof testDb>;
  beforeAll(() => {
    db = testDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const mapped = async (write: Promise<unknown>) => {
    try {
      await write;
      return 'accepted';
    } catch (error) {
      const api = mapDatabaseError(error);
      return api ? { status: api.status, code: api.code } : String(error);
    }
  };

  it('a second live contract is STAFF_CONTRACT_LIVE_EXISTS; a permanent end date is STAFF_CONTRACT_END_REQUIRED (inside VALIDATION_FAILED)', async () => {
    const school = await createSchool();
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    const base = { schoolId: school.id, staffId: principal.staffId, startsOn: day('2026-04-01'), createdBy: principal.userId };
    await db.staffContract.create({ data: { ...base, type: 'permanent' } });
    expect(await mapped(db.staffContract.create({ data: { ...base, type: 'permanent' } }))).toEqual({
      status: 409,
      code: ErrorCode.STAFF_CONTRACT_LIVE_EXISTS,
    });
    const other = await createSchoolUser(db, school, { systemRole: 'teacher' });
    expect(await mapped(db.staffContract.create({
      data: { ...base, staffId: other.staffId, type: 'permanent', endsOn: day('2027-03-31') },
    }))).toEqual({ status: 422, code: ErrorCode.VALIDATION_FAILED });
  });

  it('an edit of a published event is EVENT_NOT_DRAFT; a section added after publish too', async () => {
    const school = await createSchool();
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    const year = await createAcademicYear(db, school, { startsOn: '2026-04-01', endsOn: '2027-03-31' });
    const klass = await createClass(db, school, year);
    const section = await createSection(db, school, klass);
    const second = await createSection(db, school, klass);
    const event = await db.event.create({
      data: {
        schoolId: school.id,
        academicYearId: year.id,
        type: 'ptm',
        title: 'Parents meeting',
        startsAt: new Date('2026-05-10T04:00:00Z'),
        endsAt: new Date('2026-05-10T06:00:00Z'),
        venue: 'Hall',
        createdBy: principal.userId,
      },
    });
    const sectionRow = (sectionId: bigint) => ({
      schoolId: school.id, eventId: event.id, sectionId, classId: klass.id, academicYearId: year.id,
    });
    await db.eventSection.create({ data: sectionRow(section.id) });
    const invite = await db.announcement.create({
      data: { schoolId: school.id, title: 'Parents meeting', body: 'Saturday 9 am.', category: 'event', priority: 'normal', createdBy: principal.userId },
    });
    await db.event.updateMany({
      where: { schoolId: school.id, id: event.id },
      data: { status: 'published', announcementId: invite.id },
    });
    expect(await mapped(db.event.updateMany({ where: { schoolId: school.id, id: event.id }, data: { title: 'Moved' } }))).toEqual({
      status: 409,
      code: ErrorCode.EVENT_NOT_DRAFT,
    });
    expect(await mapped(db.eventSection.create({ data: sectionRow(second.id) }))).toEqual({
      status: 409,
      code: ErrorCode.EVENT_NOT_DRAFT,
    });
  });
});
