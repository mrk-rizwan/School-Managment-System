// Phase 5 slice 40 over HTTP (phase-5-extended.md rule 36, R322-R325; contracts/slice-40.md):
// the verification queue, verify and reject (never the uploader, decided once), the checklist from
// the newest row per required type, the incomplete-admissions report, the required-types setting,
// the family checklist (status and fixed text only), the list badge and the Approvals section.
// Verification never gates anything (R324). The real AppModule and database.
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Capability, ErrorCode, SYSTEM_ROLE_DEFAULTS, type DocumentType } from '@asms/shared';
import { loadEnv } from '../../src/config/env';
import { createTestApp } from '../core/app';
import { guardianLogin, studentLogin } from '../diary/support';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClass,
  createClassWithSection,
  createSection,
  createGuardian,
  createStudent,
  enrol,
  isoDay,
  linkGuardian,
  type TestSection,
  type TestStudent,
} from '../support/students';

const ORIGIN = new URL(loadEnv().APP_URL).origin;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface Caller {
  user: TestSchoolUser;
  cookie: string;
}
interface Doc {
  id: string;
  studentId: string;
  type: DocumentType;
  status: string;
  decidedAt: string | null;
  decidedByName: string | null;
  rejectReason: string | null;
  uploadedBy: string;
}
interface Queued extends Doc {
  student: { id: string; admissionNo: string; fullName: string; className: string | null; sectionName: string | null };
  ownUpload: boolean;
}
interface Page<T> {
  data: T[];
  total: number;
}
interface ErrorBody {
  error: { code: string; details: Record<string, unknown> | null };
}

describe('slice 40: document verification (e2e)', () => {
  let app: NestExpressApplication;
  const db = testDb();
  const http = () => request(app.getHttpServer());
  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

  const get = (path: string, c: { cookie: string }) => http().get(`/api/v1${path}`).set('Cookie', c.cookie);
  const post = (path: string, c: { cookie: string }, body?: object) => {
    const req = http().post(`/api/v1${path}`).set('Cookie', c.cookie).set('Origin', ORIGIN);
    return body === undefined ? req : req.send(body);
  };
  const patch = (path: string, c: { cookie: string }, body: object) =>
    http().patch(`/api/v1${path}`).set('Cookie', c.cookie).set('Origin', ORIGIN).send(body);

  async function caller(school: TestSchool, systemRole: 'principal' | 'office_staff' | 'teacher', fullName?: string): Promise<Caller> {
    const user = await createSchoolUser(db, school, { systemRole, ...(fullName ? { fullName } : {}) });
    return { user, cookie: (await createSchoolSession(db, school, user)).cookie };
  }

  const objectKey = (school: TestSchool, ext: string) =>
    `${school.id}/01J${Array.from({ length: 23 }, () => CROCKFORD[randomInt(0, 32)]).join('')}.${ext}`;

  /** A committed document, as POST /students/:id/documents leaves it (born `uploaded`). */
  async function document(
    school: TestSchool,
    student: Pick<TestStudent, 'id'>,
    type: DocumentType,
    uploader: Caller,
    createdAt?: Date,
  ): Promise<string> {
    const row = await db.studentDocument.create({
      data: {
        schoolId: school.id,
        studentId: student.id,
        type,
        // A photo is an image (student_documents_photo_mime_check).
        objectKey: objectKey(school, type === 'photo' ? 'jpg' : 'pdf'),
        mime: type === 'photo' ? 'image/jpeg' : 'application/pdf',
        sizeBytes: 100,
        uploadedBy: uploader.user.userId,
        ...(createdAt ? { createdAt } : {}),
      },
    });
    return row.id.toString();
  }

  interface World {
    school: TestSchool;
    principal: Caller;
    office: Caller;
    office2: Caller;
    teacher: Caller;
    year: { id: bigint };
    section: TestSection;
    child: TestStudent;
  }

  async function world(): Promise<World> {
    const school = await createSchool();
    await db.schoolSettings.create({ data: { schoolId: school.id } });
    const { year, section } = await createClassWithSection(db, school);
    const child = await createStudent(db, school, { fullName: 'Ayesha Khan' });
    await enrol(db, school, child, section);
    return {
      school,
      principal: await caller(school, 'principal', 'Nadia Principal'),
      office: await caller(school, 'office_staff', 'Omar Office'),
      office2: await caller(school, 'office_staff', 'Sara Office'),
      teacher: await caller(school, 'teacher'),
      year,
      section,
      child,
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('R325: office staff and the principal hold document.verify by default; a teacher does not', () => {
    expect(SYSTEM_ROLE_DEFAULTS.office_staff).toContain(Capability.DOCUMENT_VERIFY);
    expect(SYSTEM_ROLE_DEFAULTS.principal).toContain(Capability.DOCUMENT_VERIFY);
    expect(SYSTEM_ROLE_DEFAULTS.teacher).not.toContain(Capability.DOCUMENT_VERIFY);
  });

  describe('R322: verify and reject', () => {
    it('another verifier verifies: decided once, audited; a second decision is DOCUMENT_ALREADY_DECIDED', async () => {
      const w = await world();
      const id = await document(w.school, w.child, 'b_form', w.office);
      const res = await post(`/documents/${id}/verify`, w.office2);
      expect(res.status).toBe(200);
      const doc = res.body as Doc;
      expect([doc.status, doc.decidedByName, doc.rejectReason]).toEqual(['verified', 'Sara Office', null]);
      expect(doc.decidedAt).not.toBeNull();

      const audit = await db.auditLog.findMany({ where: { schoolId: w.school.id, action: { startsWith: 'document.' } } });
      expect(audit.map((a) => [a.action, a.subjectId, a.actorUserId])).toEqual([
        ['document.verified', BigInt(id), w.office2.user.userId],
      ]);

      for (const r of [await post(`/documents/${id}/verify`, w.principal), await post(`/documents/${id}/reject`, w.principal, { reason: 'Blurred scan' })]) {
        expect([r.status, errorOf(r).code, errorOf(r).details]).toEqual([
          409,
          ErrorCode.DOCUMENT_ALREADY_DECIDED,
          { documentId: id, status: 'verified' },
        ]);
      }
    });

    it('the uploader never decides their own upload, the principal included (SELF_ACTION_FORBIDDEN own_upload)', async () => {
      const w = await world();
      const byOffice = await document(w.school, w.child, 'b_form', w.office);
      const byPrincipal = await document(w.school, w.child, 'photo', w.principal);
      for (const [id, who] of [
        [byOffice, w.office],
        [byPrincipal, w.principal],
      ] as const) {
        for (const r of [await post(`/documents/${id}/verify`, who), await post(`/documents/${id}/reject`, who, { reason: 'Wrong child' })]) {
          expect([r.status, errorOf(r).code, errorOf(r).details]).toEqual([409, ErrorCode.SELF_ACTION_FORBIDDEN, { reason: 'own_upload' }]);
        }
      }
      expect((await db.studentDocument.findFirst({ where: { schoolId: w.school.id, id: BigInt(byOffice) } }))?.status).toBe('uploaded');
    });

    it('reject needs a reason (no identity number); the reason is kept for staff; a re-upload is a new uploaded row', async () => {
      const w = await world();
      const id = await document(w.school, w.child, 'b_form', w.office);
      expect((await post(`/documents/${id}/reject`, w.office2, {})).status).toBe(422);
      expect((await post(`/documents/${id}/reject`, w.office2, { reason: 'ok' })).status).toBe(422);
      expect((await post(`/documents/${id}/reject`, w.office2, { reason: 'B-Form 3520212345671 is unreadable' })).status).toBe(422);

      const res = await post(`/documents/${id}/reject`, w.office2, { reason: 'The scan is blurred' });
      expect(res.status).toBe(200);
      expect([(res.body as Doc).status, (res.body as Doc).rejectReason]).toEqual(['rejected', 'The scan is blurred']);
      const audit = await db.auditLog.findFirst({ where: { schoolId: w.school.id, action: 'document.rejected' } });
      expect([audit?.reason, audit?.subjectId]).toEqual(['The scan is blurred', BigInt(id)]);

      // The staff list carries the decision.
      const list = (await get(`/students/${w.child.id}/documents`, w.office).expect(200)).body as Page<Doc>;
      expect(list.data.map((d) => [d.id, d.status, d.rejectReason, d.decidedByName])).toEqual([
        [id, 'rejected', 'The scan is blurred', 'Sara Office'],
      ]);

      // A re-upload is a new row, born uploaded; the rejected one is unchanged.
      const again = await document(w.school, w.child, 'b_form', w.office);
      const checklist = (await get(`/students/${w.child.id}/document-checklist`, w.office).expect(200)).body as {
        items: { type: string; status: string; document: Doc | null }[];
      };
      expect(checklist.items.find((i) => i.type === 'b_form')?.document?.id).toBe(again);
      expect(checklist.items.find((i) => i.type === 'b_form')?.status).toBe('uploaded');
    });

    it('guards: a teacher is 403, a guardian 403, another school 404, an unknown id 404', async () => {
      const w = await world();
      const other = await world();
      const id = await document(w.school, w.child, 'b_form', w.office);
      expect((await post(`/documents/${id}/verify`, w.teacher)).status).toBe(403);
      expect((await get('/documents', w.teacher)).status).toBe(403);
      expect((await get('/documents/incomplete-admissions', w.teacher)).status).toBe(403);
      const guardian = await createGuardian(db, w.school);
      await linkGuardian(db, w.school, w.child, guardian, { canLogin: true });
      const parent = await guardianLogin(db, w.school, guardian);
      expect((await post(`/documents/${id}/verify`, parent)).status).toBe(403);
      expect((await get('/documents', parent)).status).toBe(403);

      expect((await post(`/documents/${id}/verify`, other.office)).status).toBe(404);
      expect((await post(`/documents/${id}/reject`, other.office, { reason: 'Not ours' })).status).toBe(404);
      expect((await post('/documents/999999999999/verify', w.office2)).status).toBe(404);
      expect((await get(`/students/${w.child.id}/document-checklist`, other.office)).status).toBe(404);
      expect((await get('/documents', other.office).expect(200)).body).toMatchObject({ total: 0 });
    });
  });

  describe('the queue and the Approvals section', () => {
    it('GET /documents: uploaded, oldest first, filters by type, class and status; marks the caller\'s own uploads', async () => {
      const w = await world();
      const elsewhere = await createSection(db, w.school, await createClass(db, w.school, w.year, { name: 'Class 9' }));
      const second = await createStudent(db, w.school, { fullName: 'Bilal Ahmed' });
      await enrol(db, w.school, second, elsewhere);
      const now = Date.now();
      const a = await document(w.school, w.child, 'b_form', w.office, new Date(now - 3000));
      const b = await document(w.school, second, 'photo', w.office2, new Date(now - 2000));
      const c = await document(w.school, w.child, 'photo', w.office, new Date(now - 1000));
      const decided = await document(w.school, second, 'b_form', w.office, new Date(now - 4000));
      await post(`/documents/${decided}/verify`, w.office2).expect(200);

      const queue = (await get('/documents', w.office).expect(200)).body as Page<Queued>;
      expect([queue.total, queue.data.map((d) => d.id)]).toEqual([3, [a, b, c]]);
      expect(queue.data.map((d) => d.ownUpload)).toEqual([true, false, true]);
      expect(queue.data[1]?.student).toMatchObject({ id: second.id.toString(), fullName: 'Bilal Ahmed', className: 'Class 9' });

      expect(((await get('/documents?sort=-createdAt', w.office).expect(200)).body as Page<Queued>).data.map((d) => d.id)).toEqual([c, b, a]);
      expect(((await get('/documents?type=photo', w.office).expect(200)).body as Page<Queued>).data.map((d) => d.id)).toEqual([b, c]);
      expect(((await get(`/documents?classId=${w.section.classId}`, w.office).expect(200)).body as Page<Queued>).data.map((d) => d.id)).toEqual([a, c]);
      expect(((await get('/documents?status=verified', w.office).expect(200)).body as Page<Queued>).data.map((d) => d.id)).toEqual([decided]);
      expect((await get('/documents?status=lost', w.office)).status).toBe(422);
      expect((await get('/documents?sort=name', w.office)).status).toBe(422);

      // The Approvals section is the queue's first page, count = its total.
      const approvals = (await get('/me/approvals', w.office).expect(200)).body as { documents?: { count: number; items: Queued[] } };
      expect([approvals.documents?.count, approvals.documents?.items.map((d) => d.id)]).toEqual([3, [a, b, c]]);
      expect(Object.keys((await get('/me/approvals', w.teacher).expect(200)).body as object)).not.toContain('documents');
    });
  });

  describe('R323: the checklist, the badge and the incomplete-admissions report', () => {
    it('the checklist reads the newest row per required type: missing, uploaded, verified, rejected', async () => {
      const w = await world();
      const old = await document(w.school, w.child, 'b_form', w.office, new Date(Date.now() - 5000));
      await post(`/documents/${old}/reject`, w.office2, { reason: 'Old scan' }).expect(200);
      const fresh = await document(w.school, w.child, 'b_form', w.office);
      await post(`/documents/${fresh}/verify`, w.office2).expect(200);
      await document(w.school, w.child, 'other', w.office);

      const read = async () =>
        (await get(`/students/${w.child.id}/document-checklist`, w.office).expect(200)).body as {
          items: { type: string; status: string; document: Doc | null }[];
          complete: boolean;
        };
      let list = await read();
      expect(list.items.map((i) => [i.type, i.status, i.document?.id ?? null])).toEqual([
        ['b_form', 'verified', fresh],
        ['photo', 'missing', null],
      ]);
      expect(list.complete).toBe(false);

      const photo = await document(w.school, w.child, 'photo', w.office);
      expect((await read()).items[1]?.status).toBe('uploaded');
      await post(`/documents/${photo}/reject`, w.office2, { reason: 'Not a passport photo' }).expect(200);
      expect((await read()).items[1]?.status).toBe('rejected');
      const photo2 = await document(w.school, w.child, 'photo', w.office);
      await post(`/documents/${photo2}/verify`, w.principal).expect(200);
      list = await read();
      expect([list.items.map((i) => i.status), list.complete]).toEqual([['verified', 'verified'], true]);

      // The list badge follows the checklist; a caller without document.view sees null.
      const badge = async (c: Caller) =>
        ((await get(`/students?q=Ayesha`, c).expect(200)).body as Page<{ id: string; documentsIncomplete: boolean | null }>).data.find(
          (s) => s.id === w.child.id.toString(),
        )?.documentsIncomplete;
      expect(await badge(w.office)).toBe(false);
      await document(w.school, w.child, 'photo', w.office);
      expect(await badge(w.office)).toBe(true);
      await db.userCapabilityGrant.create({
        data: {
          schoolId: w.school.id,
          userId: w.office.user.userId,
          capabilityKey: Capability.DOCUMENT_VIEW,
          effect: 'revoke',
          grantedBy: w.principal.user.userId,
          reason: 'Test revoke',
        },
      });
      expect(await badge(w.office)).toBeNull();
    });

    it('the required types are a school setting: ordered, distinct, validated, audited; an empty list requires nothing', async () => {
      const w = await world();
      const set = (body: object) => patch('/school/settings', w.principal, body);
      expect(((await get('/school/settings', w.principal).expect(200)).body as { requiredDocumentTypes: string[] }).requiredDocumentTypes).toEqual([
        'b_form',
        'photo',
      ]);
      const res = await set({ requiredDocumentTypes: ['guardian_cnic', 'b_form'] });
      expect(res.status).toBe(200);
      expect((res.body as { requiredDocumentTypes: string[] }).requiredDocumentTypes).toEqual(['b_form', 'guardian_cnic']);
      const audit = await db.auditLog.findFirst({ where: { schoolId: w.school.id, action: 'school_settings.updated' }, orderBy: { id: 'desc' } });
      expect(audit?.metadata).toMatchObject({ changes: { requiredDocumentTypes: { from: 'b_form,photo', to: 'b_form,guardian_cnic' } } });
      expect((await set({ requiredDocumentTypes: ['b_form', 'b_form'] })).status).toBe(422);
      expect((await set({ requiredDocumentTypes: ['passport'] })).status).toBe(422);
      expect((await set({ requiredDocumentTypes: null })).status).toBe(422);
      // The office does not hold school.settings.manage.
      expect((await patch('/school/settings', w.office, { requiredDocumentTypes: [] })).status).toBe(403);

      const checklist = async () =>
        ((await get(`/students/${w.child.id}/document-checklist`, w.office).expect(200)).body as { items: { type: string }[]; complete: boolean });
      expect((await checklist()).items.map((i) => i.type)).toEqual(['b_form', 'guardian_cnic']);
      await set({ requiredDocumentTypes: [] }).expect(200);
      expect(await checklist()).toEqual({ studentId: w.child.id.toString(), items: [], complete: true });
      expect(((await get('/documents/incomplete-admissions', w.office).expect(200)).body as Page<unknown>).total).toBe(0);
    });

    it('incomplete admissions: on-roll students admitted in the window with a required type missing, awaiting or rejected', async () => {
      const w = await world();
      const admitted = async (name: string, daysAgo: number, status: 'active' | 'withdrawn' = 'active') => {
        const s = await createStudent(db, w.school, { fullName: name, admittedOn: isoDay(-daysAgo), status });
        if (status === 'active') await enrol(db, w.school, s, w.section, { startedOn: isoDay(-daysAgo) });
        return s;
      };
      // w.child (admitted today): nothing uploaded.
      const complete = await admitted('Complete Child', 10);
      for (const type of ['b_form', 'photo'] as const) {
        await post(`/documents/${await document(w.school, complete, type, w.office)}/verify`, w.office2).expect(200);
      }
      const awaiting = await admitted('Awaiting Child', 20);
      await document(w.school, awaiting, 'b_form', w.office);
      const rejected = await admitted('Rejected Child', 30);
      await post(`/documents/${await document(w.school, rejected, 'b_form', w.office)}/reject`, w.office2, { reason: 'Blurred' }).expect(200);
      await post(`/documents/${await document(w.school, rejected, 'photo', w.office)}/verify`, w.office2).expect(200);
      const early = await admitted('Early Child', 120);
      await admitted('Gone Child', 5, 'withdrawn');

      interface Row {
        studentId: string;
        fullName: string;
        admittedOn: string;
        className: string | null;
        missing: string[];
        awaiting: string[];
        rejected: string[];
      }
      const report = async (query = '') => (await get(`/documents/incomplete-admissions${query}`, w.office).expect(200)).body as Page<Row>;
      const byDefault = await report();
      expect(byDefault.data.map((r) => [r.fullName, r.missing, r.awaiting, r.rejected])).toEqual([
        ['Rejected Child', [], [], ['b_form']],
        ['Awaiting Child', ['photo'], ['b_form'], []],
        ['Ayesha Khan', ['b_form', 'photo'], [], []],
      ]);
      expect(byDefault.total).toBe(3);
      expect(byDefault.data[0]?.className).not.toBeNull();

      const wide = await report(`?admittedFrom=${isoDay(-365)}&admittedTo=${isoDay()}&sort=-admittedOn&limit=2`);
      expect([wide.total, wide.data.map((r) => r.fullName)]).toEqual([4, ['Ayesha Khan', 'Awaiting Child']]);
      expect((await report(`?admittedFrom=${isoDay(-365)}&sort=-admittedOn&page=2&limit=2`)).data.map((r) => r.studentId)).toEqual([
        rejected.id.toString(),
        early.id.toString(),
      ]);

      expect((await get(`/documents/incomplete-admissions?admittedFrom=${isoDay(1)}&admittedTo=${isoDay()}`, w.office)).status).toBe(422);
      expect((await get('/documents/incomplete-admissions?admittedFrom=2026-02-30', w.office)).status).toBe(422);
    });
  });

  describe('R322: the family checklist carries status and fixed text, never the reason or the decider', () => {
    it('a guardian reads their child\'s; a student their own; another child is 404', async () => {
      const w = await world();
      const reason = 'Clerk note: smudged corner';
      const doc = await document(w.school, w.child, 'b_form', w.office);
      await post(`/documents/${doc}/reject`, w.office2, { reason }).expect(200);
      const guardian = await createGuardian(db, w.school);
      await linkGuardian(db, w.school, w.child, guardian, { canLogin: true });
      const parent = await guardianLogin(db, w.school, guardian);

      const res = await get(`/me/children/${w.child.id}/documents`, parent);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        studentId: w.child.id.toString(),
        items: [
          { type: 'b_form', status: 'rejected', note: 'Please re-upload the B-Form.' },
          { type: 'photo', status: 'missing', note: 'Please send the photo to the school office.' },
        ],
      });
      for (const leak of [reason, 'Sara Office', 'Omar Office', doc, 'decided', 'objectKey']) {
        expect(res.text).not.toContain(leak);
      }

      const stranger = await createStudent(db, w.school);
      await enrol(db, w.school, stranger, w.section);
      expect((await get(`/me/children/${stranger.id}/documents`, parent)).status).toBe(404);
      // The staff checklist is not reachable by a family.
      expect((await get(`/students/${w.child.id}/document-checklist`, parent)).status).toBe(403);

      await db.schoolSettings.updateMany({ where: { schoolId: w.school.id }, data: { studentLoginEnabled: true } });
      const own = await studentLogin(db, w.school, w.child);
      const mine = await get('/me/student/documents', own);
      expect(mine.status).toBe(200);
      expect((mine.body as { items: unknown[] }).items).toEqual((res.body as { items: unknown[] }).items);
      expect(mine.text).not.toContain(reason);
      expect((await get('/me/student/documents', parent)).status).toBe(403);
    });
  });

  it('R324: verification never blocks admission, enrolment or a status change', async () => {
    const w = await world();
    const doc = await document(w.school, w.child, 'b_form', w.office);
    await post(`/documents/${doc}/reject`, w.office2, { reason: 'Unreadable' }).expect(200);
    const res = await post(`/students/${w.child.id}/change-status`, w.office, {
      status: 'suspended',
      reason: 'Behaviour review',
      effectiveOn: isoDay(),
    });
    expect([res.status, (res.body as { status?: string }).status]).toEqual([200, 'suspended']);
    // The decision changed nothing but the document.
    expect((await db.student.findFirst({ where: { schoolId: w.school.id, id: w.child.id } }))?.status).toBe('suspended');
  });
});
