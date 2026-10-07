// The wave N certificates table in the database (phase-4-academic.md §3.2 "Certificates", rule
// 29, R289-R293): no delete, no truncate, school_id immutable, the number and reissue keys, the
// CHECKs (dues, reissue, title, year, the body that never holds an identity number) and the
// columns frozen after issue. Raw SQL inside one rolled-back transaction, each statement behind
// its own savepoint (an exemption in guardrails/no-truncate.spec.ts).
import { Client, type DatabaseError } from 'pg';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb } from '../support/schools';
import { createCertificate, createMarksFixture, type MarksFixture } from './assessment-fixture';

describe('wave N certificate guards (raw SQL)', () => {
  const db = testDb();
  let pg: Client;
  let seq = 0;
  let f: MarksFixture;
  let otherSchoolId: bigint;
  let otherUserId: bigint;
  /** Character certificate CC-0001, issue 1. */
  let original: bigint;
  /** Character certificate CC-0002, voided. */
  let voided: bigint;

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

  /** INSERT INTO certificates: a character certificate of the fixture's student; `cols` override. */
  const insert = (cols: Record<string, unknown> = {}): Promise<string | null> => {
    const row: Record<string, unknown> = {
      school_id: f.school.id,
      student_id: f.studentId,
      type: 'character',
      number: 50,
      academic_year_id: f.yearId,
      body: JSON.stringify({ studentName: 'Test Student', conduct: 'Good' }),
      dues_status: 'not_required',
      issued_by: f.userId,
      issued_on: '2026-06-01',
      ...cols,
    };
    const names = Object.keys(row);
    return refusedBy(
      `INSERT INTO certificates (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };

  const update = (set: string, id: bigint, params: unknown[] = []): Promise<string | null> =>
    refusedBy(`UPDATE certificates SET ${set} WHERE school_id = $1 AND id = $2`, [f.school.id, id, ...params]);

  beforeAll(async () => {
    const school = await createSchool();
    f = await createMarksFixture(school);
    const other = await createSchool();
    otherSchoolId = other.id;
    otherUserId = (await createSchoolUser(db, other, { systemRole: 'principal' })).userId;
    original = (await createCertificate(f, 1)).id;
    voided = (await createCertificate(f, 2)).id;
    await db.certificate.updateMany({
      where: { schoolId: f.school.id, id: voided },
      data: { voidedAt: new Date(), voidedBy: f.userId, voidReason: 'Issued to the wrong student' },
    });
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query('BEGIN');
    await pg.query(`SET LOCAL lock_timeout = '5s'`);
  });

  afterAll(async () => {
    await pg.query('ROLLBACK');
    await pg.end();
    await closeTestDb();
  });

  it('certificates: rows are never deleted or truncated, and school_id never changes', async () => {
    expect(await refusedBy(`DELETE FROM certificates WHERE school_id = $1`, [f.school.id])).toBe('certificates_no_delete');
    const truncate = await refusedBy('TRUNCATE certificates');
    expect(truncate).not.toBeNull();
    expect(await refusedBy(`UPDATE certificates SET school_id = $1 WHERE school_id = $2`, [otherSchoolId, f.school.id])).toBe(
      'certificates_school_id_immutable',
    );
  });

  it('R290: a number is issued once per type; a reissue keeps the type and number, names the original and gives a reason', async () => {
    expect(await insert({ number: 1 })).toBe('certificates_school_id_type_number_issue_no_key');
    expect(await insert({ number: 1, type: 'academic' })).toBeNull();
    expect(await insert({ number: 0 })).toBe('certificates_number_check');
    expect(await insert({ number: 1, issue_no: 2, reissue_of_id: original, reason: 'Lost' })).toBeNull();
    expect(await insert({ number: 1, issue_no: 2, reason: 'Lost' })).toBe('certificates_issue_no_check');
    expect(await insert({ number: 1, issue_no: 1, reissue_of_id: original, reason: 'Lost' })).toBe('certificates_issue_no_check');
    expect(await insert({ number: 1, issue_no: 2, reissue_of_id: original })).toBe('certificates_reissue_reason_check');
    expect(await insert({ number: 7, issue_no: 2, reissue_of_id: original, reason: 'Lost' })).toBe('certificates_reissue_of_id_fkey');
    expect(
      await insert({ type: 'academic', number: 1, issue_no: 2, reissue_of_id: original, reason: 'Lost' }),
    ).toBe('certificates_reissue_of_id_fkey');
  });

  it('R291: only the leaving certificate is gated on dues, and an override carries its reason', async () => {
    expect(await insert({ type: 'leaving', number: 1 })).toBe('certificates_dues_check');
    expect(await insert({ dues_status: 'cleared' })).toBe('certificates_dues_check');
    expect(await insert({ type: 'leaving', number: 1, dues_status: 'override' })).toBe('certificates_dues_check');
    expect(await insert({ type: 'leaving', number: 1, dues_status: 'override', reason: 'Fees waived by the principal' })).toBeNull();
    expect(await insert({ type: 'leaving', number: 1, dues_status: 'cleared' })).toBeNull();
  });

  it('rule 29: the year is optional and the title required only on an `other` certificate; texts are clean', async () => {
    expect(await insert({ academic_year_id: null })).toBe('certificates_academic_year_check');
    expect(await insert({ type: 'other', number: 1, academic_year_id: null })).toBe('certificates_title_required_check');
    expect(await insert({ type: 'other', number: 1, academic_year_id: null, title: 'Sports certificate' })).toBeNull();
    expect(await insert({ type: 'other', number: 1, title: ' Padded' })).toBe('certificates_title_check');
    expect(await insert({ type: 'other', number: 1, title: 'For 35202-1234567-1' })).toBe('certificates_title_no_id_check');
    // Wave N review: a title only on `other`, and never a leaving certificate's.
    expect(await insert({ title: 'Character and Conduct' })).toBe('certificates_title_other_check');
    expect(await insert({ type: 'other', number: 1, title: 'School LEAVING certificate' })).toBe('certificates_title_other_check');
    expect(await insert({ type: 'other', number: 1, title: 'Leaver of the year' })).toBe('certificates_title_other_check');
    expect(await insert({ type: 'leaving', number: 1, dues_status: 'override', reason: 'B-Form 3520212345671' })).toBe(
      'certificates_reason_no_id_check',
    );
  });

  it('§7.1: the body is an object and never holds an identity number', async () => {
    expect(await insert({ body: JSON.stringify(['a']) })).toBe('certificates_body_check');
    expect(await insert({ body: JSON.stringify({ bForm: '3520212345671' }) })).toBe('certificates_body_no_id_check');
    expect(await insert({ body: JSON.stringify({ father: { cnic: '35202-1234567-1' } }) })).toBe('certificates_body_no_id_check');
    expect(await insert({ body: JSON.stringify({ marks: [{ subject: 'Maths', obtained: 78, max: 100 }] }) })).toBeNull();
  });

  it('certificates: after issue only printed_count and the void trio change, and a void is final', async () => {
    expect(await update('printed_count = printed_count + 1', original)).toBeNull();
    expect(await update('printed_count = -1', original)).toBe('certificates_printed_count_check');
    expect(await update(`body = '{"studentName": "Someone else"}'`, original)).toBe('certificates_body_immutable');
    expect(await update('number = 9', original)).toBe('certificates_number_immutable');
    expect(await update('student_id = student_id + 1', original)).toBe('certificates_student_id_immutable');
    expect(await update(`dues_status = 'cleared'`, original)).toBe('certificates_dues_status_immutable');
    expect(await update('voided_at = now()', original)).toBe('certificates_voided_check');
    expect(await update(`voided_at = now(), voided_by = $3, void_reason = 'Wrong year'`, original, [f.userId])).toBeNull();
    expect(await update('voided_at = NULL, voided_by = NULL, void_reason = NULL', voided)).toBe('certificates_voided_at_frozen');
    expect(await update(`void_reason = 'Changed'`, voided)).toBe('certificates_void_reason_frozen');
    expect(await update('printed_count = printed_count + 1', voided)).toBeNull();
  });

  it('refuses a certificate in another school naming this school’s student or original (composite foreign keys)', async () => {
    expect(await insert({ school_id: otherSchoolId, issued_by: otherUserId, academic_year_id: null, type: 'other', title: 'X' })).toBe(
      'certificates_student_id_fkey',
    );
  });
});
