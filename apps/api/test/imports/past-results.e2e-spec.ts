// Slice 43 over HTTP: past-results imports (phase-5-extended.md rule 39, §0.34, R339-R341, R343;
// contracts/slice-43.md). The slice-30 mark room (class Six, 6-A and 6-B, Mathematics and English,
// the Mid-term ending today) with no exams set up: a preview writes only the import row and reports
// every row error by line; an identity-shaped cell is refused and never stored; a commit writes the
// exams, the marks, a sheet born published with provenance `imported` and its results in one
// transaction, sends nothing, and ranks the class once both sections are in; the refusals; the key;
// expiry by the commit and by the sweep; isolation. The real AppModule and database.
import { ErrorCode } from '@asms/shared';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { StagedUploadSweep } from '../../src/modules/documents/staged-upload.sweep';
import { ResultNotifyJob } from '../../src/modules/results/result-notify.job';
import { SchoolClock } from '../../src/common/school-clock';
import { markRoom, type MarkRoom } from '../assessments/support';
import { asSchool } from '../messaging/support';
import { createTest, enterMarks, openSheet } from '../results/support';
import { StaffHarness } from '../staff/support';
import { closeTestDb, createSchool } from '../support/schools';
import { isoDay } from '../support/students';
import { csv, errorOf, importsHttp, type ImportDetail } from './support';

const IDENTITY = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;

describe('slice 43: past-results imports (e2e)', () => {
  const h = new StaffHarness();
  const db = h.db;
  const x = importsHttp(() => h.app);

  beforeAll(async () => {
    await h.start();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  const midTerm = async (room: MarkRoom) =>
    db.academicTerm.findFirstOrThrow({
      where: { schoolId: room.school.id, academicYearId: room.year.id },
      orderBy: { sortOrder: 'asc' },
    });

  /** A valid 6-A file: Zara 80 / Ab, Ali 90 / 70 (header in another order and case). */
  const sixAFile = (room: MarkRoom) =>
    csv(['Admission_No', 'english', 'MATHEMATICS'], [room.child1.admissionNo, 'Ab', 80], [room.child2.admissionNo, 70, 90]);

  const fieldsOf = async (room: MarkRoom, sectionId = room.sixA.id) => ({
    sectionId: sectionId.toString(),
    termId: (await midTerm(room)).id.toString(),
  });

  const counts = async (room: MarkRoom) => ({
    imports: await db.import.count({ where: { schoolId: room.school.id } }),
    assessments: await db.assessment.count({ where: { schoolId: room.school.id } }),
    marks: await db.mark.count({ where: { schoolId: room.school.id } }),
    sheets: await db.resultSheet.count({ where: { schoolId: room.school.id } }),
    results: await db.result.count({ where: { schoolId: room.school.id } }),
  });

  const audits = (room: MarkRoom, action: string) =>
    db.auditLog.findMany({ where: { schoolId: room.school.id, action }, orderBy: { id: 'asc' } });

  it('R339: a preview validates every row and writes the import row only; the rows show names, marks and each exam max', async () => {
    const room = await markRoom(h);
    const res = await x.preview('past-results', await fieldsOf(room), sixAFile(room), room.principal.cookie, { fileName: 'C:\\exports\\six-a mid term.csv' });
    expect(res.status).toBe(201);
    const body = res.body as ImportDetail;
    expect(body).toMatchObject({
      kind: 'past_results',
      status: 'previewed',
      fileName: 'six-a mid term.csv',
      rowCount: 2,
      errorCount: 0,
      errors: [],
      sectionId: room.sixA.id.toString(),
      createdByName: 'Nadia Principal',
      resultSheetId: null,
    });
    expect(body.subjects.map((s) => [s.name, s.maxMarks])).toEqual([
      ['Mathematics', 100],
      ['English', 100],
    ]);
    expect(body.rows.map((r) => [r.row, r.studentName, r.marks?.map((m) => m.obtained)])).toEqual([
      [2, 'Zara Khan', [80, null]],
      [3, 'Ali Raza', [90, 70]],
    ]);
    expect(await counts(room)).toEqual({ imports: 1, assessments: 0, marks: 0, sheets: 0, results: 0 });
    expect((await audits(room, 'import.previewed')).map((a) => a.metadata)).toEqual([
      expect.objectContaining({ kind: 'past_results', rowCount: 2, errorCount: 0 }),
    ]);
    // Read back by id and in the history.
    expect((await x.get(`/imports/${body.id}`, room.principal.cookie)).body).toMatchObject({ id: body.id, rows: expect.any(Array) });
    const list = (await x.get('/imports?kind=past_results&status=previewed', room.principal.cookie)).body as { data: { id: string }[]; total: number };
    expect([list.total, list.data[0]?.id]).toEqual([1, body.id]);
  });

  it('R339: every row error with its file line; a roster student missing from the file is an error; the commit refuses the file', async () => {
    const room = await markRoom(h);
    const file = csv(
      ['admission_no', 'Mathematics', 'English'],
      [room.child1.admissionNo, 101, 50], // line 2: over max
      [room.childB.admissionNo, 10, 10], // line 3: in 6-B, not on this roster
      ['999999999999', 10, 10], // line 4: no such student
      [room.child1.admissionNo, 10, 10], // line 5: duplicate
      ['', 'Abs', ''], // line 6: required, a bad Ab, required
    );
    const res = await x.preview('past-results', await fieldsOf(room), file, room.principal.cookie);
    expect(res.status).toBe(201);
    const body = res.body as ImportDetail;
    expect(body.errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [2, 'Mathematics', 'over_max'],
      [3, 'admission_no', 'not_on_roster'],
      [4, 'admission_no', 'unknown_admission_no'],
      [5, 'admission_no', 'duplicate'],
      [6, 'admission_no', 'required'],
      [6, 'Mathematics', 'invalid_mark'],
      [6, 'English', 'required'],
      [0, 'admission_no', 'missing_from_file'],
    ]);
    expect(body.errors.at(-1)?.admissionNo).toBe(room.child2.admissionNo);
    expect([body.errorCount, body.rows]).toEqual([8, []]);
    const commit = await x.commit(body.id, room.principal.cookie);
    expect([commit.status, errorOf(commit).code, errorOf(commit).details?.errorCount]).toEqual([422, ErrorCode.IMPORT_ROWS_INVALID, 8]);
    expect(await counts(room)).toMatchObject({ imports: 1, assessments: 0, marks: 0, sheets: 0 });
    // The header's own problems stop there (row 1).
    const header = await x.preview('past-results', await fieldsOf(room), csv(['roll', 'Mathematics', 'Urdu'], ['1', '2', '3']), room.principal.cookie);
    expect((header.body as ImportDetail).errors.map((e) => [e.row, e.field, e.code])).toEqual([
      [1, 'roll', 'first_column'],
      [1, 'Urdu', 'unknown_column'],
      [1, 'English', 'missing_column'],
    ]);
  });

  it('R339, §7.1: an identity-shaped admission number is refused as identity_number and is never stored or echoed; an unreadable file writes nothing', async () => {
    const room = await markRoom(h);
    const cnic = '42101-1234567-1';
    const file = csv(['admission_no', 'Mathematics', 'English'], [cnic, 1, 1], ['4210112345671', 1, 1], [room.child1.admissionNo, 1, 1], [room.child2.admissionNo, 1, 1]);
    const res = await x.preview('past-results', await fieldsOf(room), file, room.principal.cookie, { fileName: `${cnic}.csv` });
    expect(res.status).toBe(201);
    expect(res.text).not.toMatch(IDENTITY);
    const body = res.body as ImportDetail;
    expect(body.fileName).toBe('import.csv');
    expect(body.errors.map((e) => [e.row, e.code])).toEqual([
      [2, 'identity_number'],
      [3, 'identity_number'],
    ]);
    const stored = await db.import.findFirstOrThrow({ where: { schoolId: room.school.id, id: BigInt(body.id) } });
    expect(JSON.stringify([stored.rows, stored.errors, stored.fileName])).not.toMatch(IDENTITY);

    // Not UTF-8, empty, ragged: 422 on `file`, no import.
    for (const bad of [Buffer.from([0x61, 0x64, 0xff, 0xfe, 0x0a]), Buffer.from(''), Buffer.from('admission_no,Mathematics,English\n1,2\n')]) {
      const refused = await x.preview('past-results', await fieldsOf(room), bad, room.principal.cookie);
      expect([refused.status, errorOf(refused).details?.fields?.[0]?.path]).toEqual([422, 'file']);
    }
    // JSON instead of a file: 422 on `file`.
    const json = await h.send('post', '/api/v1/imports/past-results', await fieldsOf(room), room.principal.cookie);
    expect(json.status).toBe(422);
    expect(await db.import.count({ where: { schoolId: room.school.id } })).toBe(1);
    expect(h.bodies.join('\n')).not.toContain('4210112345671');
  });

  it('R340, R343: the commit writes exams, marks, a published imported sheet and its results in one go, sends nothing, and ranks the class once both sections are in', async () => {
    const room = await markRoom(h);
    const notify = jest.spyOn(h.app.get(OutboxDispatcher, { strict: false }), 'resultNotifyAfterCommit');
    const term = await midTerm(room);
    const preview = (await x.preview('past-results', await fieldsOf(room), sixAFile(room), room.principal.cookie)).body as ImportDetail;
    const res = await x.commit(preview.id, room.principal.cookie);
    expect(res.status).toBe(200);
    const done = res.body as ImportDetail;
    expect(done).toMatchObject({ status: 'committed', committedByName: 'Nadia Principal', resultSheetId: expect.any(String) });

    const exams = await db.assessment.findMany({ where: { schoolId: room.school.id, sectionId: room.sixA.id, termId: term.id }, orderBy: { id: 'asc' } });
    expect(exams.map((e) => [e.kind, e.maxMarks, e.heldOn.toISOString().slice(0, 10), e.createdBy])).toEqual([
      ['exam', 100, term.endsOn.toISOString().slice(0, 10), room.principal.userId],
      ['exam', 100, term.endsOn.toISOString().slice(0, 10), room.principal.userId],
    ]);
    const marks = await db.mark.findMany({ where: { schoolId: room.school.id }, orderBy: { id: 'asc' } });
    expect(marks.map((m) => [m.studentId, m.obtained, m.absent, m.status])).toEqual(
      expect.arrayContaining([
        [room.child1.id, 80, false, 'live'],
        [room.child1.id, null, true, 'live'],
        [room.child2.id, 90, false, 'live'],
        [room.child2.id, 70, false, 'live'],
      ]),
    );
    expect(marks).toHaveLength(4);

    const sheet = await db.resultSheet.findFirstOrThrow({ where: { schoolId: room.school.id, id: BigInt(done.resultSheetId ?? '0') } });
    expect(sheet).toMatchObject({
      status: 'published',
      provenance: 'imported',
      importId: BigInt(done.id),
      version: 1,
      submittedBy: null,
      decidedBy: room.principal.userId,
      publishedBy: room.principal.userId,
      testWeight: 0,
      examWeight: 100,
      passPercent: 40,
    });
    const results = await db.result.findMany({ where: { schoolId: room.school.id, sheetId: sheet.id }, orderBy: { position: 'asc' } });
    expect(results.map((r) => [r.studentId, r.percentBp, r.position, r.positionOf, r.publishedAt !== null, r.notifiedAt !== null])).toEqual([
      [room.child2.id, 8000, 1, 2, true, true],
      [room.child1.id, 4000, 2, 2, true, true],
    ]);
    // No message: nothing enqueued, and the notify job finds nothing untold.
    expect(notify).not.toHaveBeenCalled();
    const job = h.app.get(ResultNotifyJob, { strict: false });
    expect(await asSchool(h.app, room.school.id, () => job.run(room.school.id, { sheetId: sheet.id }))).toBe(0);
    expect(await db.message.count({ where: { schoolId: room.school.id } })).toBe(0);
    // R343: the card says so; the print too.
    const resultId = results[0]?.id ?? 0n;
    expect((await h.get(`/api/v1/results/${resultId}`, room.principal.cookie)).body).toMatchObject({ imported: true, percentBp: 8000 });
    const print = await h.get(`/api/v1/results/${resultId}/print`, room.principal.cookie);
    expect(print.text).toContain('Imported from the school');
    expect((await db.auditLog.findMany({ where: { schoolId: room.school.id, action: 'import.committed' } })).map((a) => a.metadata)).toEqual([
      expect.objectContaining({ kind: 'past_results', rows: 2, results: 2, examsCreated: 2, marks: 4, rankingId: 'none' }),
    ]);

    // 6-A alone does not complete the class: no ranking. 6-B's import completes it.
    expect(await db.classRanking.count({ where: { schoolId: room.school.id } })).toBe(0);
    const b = (await x.preview('past-results', await fieldsOf(room, room.sixB.id), csv(['admission_no', 'Mathematics', 'English'], [room.childB.admissionNo, 85, 85]), room.principal.cookie)).body as ImportDetail;
    await x.commit(b.id, room.principal.cookie).expect(200);
    const ranking = await db.classRanking.findFirstOrThrow({ where: { schoolId: room.school.id, classId: room.klass.id, termId: term.id, supersededAt: null } });
    expect(ranking.trigger).toBe('import');
    const rows = await db.classRankingRow.findMany({ where: { schoolId: room.school.id, rankingId: ranking.id }, orderBy: { classPosition: 'asc' } });
    expect(rows.map((r) => [r.studentId, r.classPosition])).toEqual([
      [room.childB.id, 1],
      [room.child2.id, 2],
      [room.child1.id, 3],
    ]);
  });

  it('R340: refused when the section-term has a sheet (IMPORT_SHEET_EXISTS) or any live mark (IMPORT_MARKS_EXIST), and into a closed year; existing exams are reused with their max', async () => {
    const room = await markRoom(h);
    const term = await midTerm(room);
    // A sheet of 6-A's Mid-term (draft) refuses the preview.
    expect((await openSheet(h, room.principal, room.sixA.id, term.id)).status).toBe(201);
    const sheet = await x.preview('past-results', await fieldsOf(room), sixAFile(room), room.principal.cookie);
    expect([sheet.status, errorOf(sheet).code]).toEqual([409, ErrorCode.IMPORT_SHEET_EXISTS]);

    // A live mark on a 6-B test refuses 6-B, previewed or committed.
    const bFile = csv(['admission_no', 'Mathematics', 'English'], [room.childB.admissionNo, 60, 60]);
    const early = (await x.preview('past-results', await fieldsOf(room, room.sixB.id), bFile, room.principal.cookie)).body as ImportDetail;
    const test = await createTest(h, room.bTeacher, { classSubjectId: room.maths.classSubjectId, sectionId: room.sixB.id, maxMarks: 20, heldOn: isoDay(-3) });
    await enterMarks(h, test, room.bTeacher, [[room.enrolmentB, 12]]);
    const late = await x.commit(early.id, room.principal.cookie);
    expect([late.status, errorOf(late).code]).toEqual([409, ErrorCode.IMPORT_MARKS_EXIST]);
    const again = await x.preview('past-results', await fieldsOf(room, room.sixB.id), `${bFile}\n`, room.principal.cookie);
    expect([again.status, errorOf(again).code]).toEqual([409, ErrorCode.IMPORT_MARKS_EXIST]);
    expect((await db.import.findFirstOrThrow({ where: { schoolId: room.school.id, id: BigInt(early.id) } })).status).toBe('previewed');

    // Existing exams keep their max: an exam set up at 50 bounds the file's marks.
    const other = await markRoom(h);
    const otherTerm = await midTerm(other);
    await h.send('post', `/api/v1/terms/${otherTerm.id}/set-up-exams`, {}, other.principal.cookie).then((r) => expect(r.status).toBe(200));
    await db.assessment.updateMany({ where: { schoolId: other.school.id, sectionId: other.sixA.id, classSubjectId: other.english.classSubjectId }, data: { maxMarks: 50 } });
    const over = (await x.preview('past-results', await fieldsOf(other), csv(['admission_no', 'Mathematics', 'English'], [other.child1.admissionNo, 90, 60], [other.child2.admissionNo, 90, 50]), other.principal.cookie)).body as ImportDetail;
    expect(over.subjects.map((s) => s.maxMarks)).toEqual([100, 50]);
    expect(over.errors.map((e) => [e.row, e.field, e.code])).toEqual([[2, 'English', 'over_max']]);
    const fine = (await x.preview('past-results', await fieldsOf(other), csv(['admission_no', 'Mathematics', 'English'], [other.child1.admissionNo, 90, 45], [other.child2.admissionNo, 90, 50]), other.principal.cookie)).body as ImportDetail;
    await x.commit(fine.id, other.principal.cookie).expect(200);
    expect(await db.assessment.count({ where: { schoolId: other.school.id, sectionId: other.sixA.id, termId: otherTerm.id } })).toBe(2);

    // A closed year takes no import.
    await db.academicYear.updateMany({ where: { schoolId: room.school.id, id: room.year.id }, data: { status: 'closed' } });
    const closed = await x.preview('past-results', await fieldsOf(room, room.sixB.id), csv(['admission_no', 'Mathematics', 'English'], [room.childB.admissionNo, 1, 1]), room.principal.cookie);
    expect([closed.status, errorOf(closed).code]).toEqual([409, ErrorCode.IMPORT_YEAR_CLOSED]);
  });

  it('R341: a committed file is refused a second time; the commit is idempotent by key; another key is IMPORT_NOT_PREVIEWED', async () => {
    const room = await markRoom(h);
    const file = csv(['admission_no', 'Mathematics', 'English'], [room.childB.admissionNo, 70, 70]);
    const first = (await x.preview('past-results', await fieldsOf(room, room.sixB.id), file, room.principal.cookie)).body as ImportDetail;
    // The same key and file again answers the same preview (200, replayed).
    const key = 'commit-key-0000000001';
    const done = await x.commit(first.id, room.principal.cookie, key);
    expect(done.status).toBe(200);
    const replay = await x.commit(first.id, room.principal.cookie, key);
    expect([replay.status, replay.headers['idempotency-replayed'], (replay.body as ImportDetail).status]).toEqual([200, 'true', 'committed']);
    const other = await x.commit(first.id, room.principal.cookie);
    expect([other.status, errorOf(other).code]).toEqual([409, ErrorCode.IMPORT_NOT_PREVIEWED]);
    expect(await db.resultSheet.count({ where: { schoolId: room.school.id } })).toBe(1);
    // The identical bytes, for another section: the file was imported already. (A second principal:
    // import-writes allows each user five a minute.)
    const second = await h.caller(room.school, 'principal');
    const dup = await x.preview('past-results', await fieldsOf(room), file, second.cookie);
    expect([dup.status, errorOf(dup).code, errorOf(dup).details?.importId]).toEqual([409, ErrorCode.IMPORT_DUPLICATE_FILE, first.id]);
    // A preview replayed with its key answers 200 with the same import.
    const k2 = 'preview-key-000000002';
    const fresh = await x.preview('past-results', await fieldsOf(room), sixAFile(room), second.cookie, { key: k2 });
    const again = await x.preview('past-results', await fieldsOf(room), sixAFile(room), second.cookie, { key: k2 });
    expect([fresh.status, again.status, (again.body as ImportDetail).id]).toEqual([201, 200, (fresh.body as ImportDetail).id]);
  });

  it('R339: a preview expires after 24 hours — at its commit (IMPORT_EXPIRED, failed "expired") and in the daily sweep', async () => {
    const room = await markRoom(h);
    const a = (await x.preview('past-results', await fieldsOf(room), sixAFile(room), room.principal.cookie)).body as ImportDetail;
    const b = (await x.preview('past-results', await fieldsOf(room, room.sixB.id), csv(['admission_no', 'Mathematics', 'English'], [room.childB.admissionNo, 1, 1]), room.principal.cookie)).body as ImportDetail;
    const later = new Date(Date.now() + 25 * 3_600_000);
    jest.spyOn(h.app.get(SchoolClock), 'now').mockReturnValue(later);
    const expired = await x.commit(a.id, room.principal.cookie);
    expect([expired.status, errorOf(expired).code]).toEqual([409, ErrorCode.IMPORT_EXPIRED]);
    expect(await db.import.findFirstOrThrow({ where: { schoolId: room.school.id, id: BigInt(a.id) } })).toMatchObject({ status: 'failed', error: 'expired' });
    const again = await x.commit(a.id, room.principal.cookie);
    expect([again.status, errorOf(again).code]).toEqual([409, ErrorCode.IMPORT_EXPIRED]);
    jest.restoreAllMocks();
    // The sweep fails the other one, with a system audit row.
    expect(await h.app.get(StagedUploadSweep).expireImports(room.school.id, later)).toBe(1);
    expect(await db.import.findFirstOrThrow({ where: { schoolId: room.school.id, id: BigInt(b.id) } })).toMatchObject({ status: 'failed', error: 'expired' });
    const failed = await db.auditLog.findMany({ where: { schoolId: room.school.id, action: 'import.failed' }, orderBy: { id: 'asc' } });
    expect(failed.map((r) => [r.subjectId, r.actorUserId])).toEqual([
      [BigInt(a.id), room.principal.userId],
      [BigInt(b.id), null],
    ]);
    expect(await counts(room)).toMatchObject({ assessments: 0, marks: 0, sheets: 0 });
  });

  it('§3.1: past results need result.publish and assessment.define; others are refused; another school sees nothing (404)', async () => {
    const room = await markRoom(h);
    for (const who of [room.office, room.classTeacher]) {
      const res = await x.preview('past-results', await fieldsOf(room), sixAFile(room), who.cookie);
      expect(res.status).toBe(403);
    }
    const mine = (await x.preview('past-results', await fieldsOf(room), sixAFile(room), room.principal.cookie)).body as ImportDetail;
    const outsider = await h.caller(await createSchool(), 'principal');
    expect((await x.get(`/imports/${mine.id}`, outsider.cookie)).status).toBe(404);
    expect((await x.commit(mine.id, outsider.cookie)).status).toBe(404);
    expect((await x.get('/imports', outsider.cookie)).body).toMatchObject({ total: 0 });
    // The office reads no past-results import (its keys reach neither kind's pair).
    expect((await x.get(`/imports/${mine.id}`, room.office.cookie)).status).toBe(404);
    // Another school's section is not found.
    const foreign = await x.preview('past-results', await fieldsOf(room), sixAFile(room), outsider.cookie);
    expect(foreign.status).toBe(404);
    expect(h.bodies.join('\n')).not.toMatch(IDENTITY);
  });
});
