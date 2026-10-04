// POST /uploads, student documents and their download end to end (contracts/slice-6.md §6.1-§6.2,
// R41-R43, R90, R91) over the real AppModule, the real database and the local object store.
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import { loadEnv } from '../../src/config/env';
import { ObjectNotFoundError, ObjectStorage } from '../../src/common/storage/object-storage';
import { StagedUploadSweep, SWEEP_GRACE_MS } from '../../src/modules/documents/staged-upload.sweep';
import { ConcurrencyLimit } from '../../src/modules/documents/upload-processing';
import { REENCODE_LIMIT } from '../../src/modules/documents/uploads.service';
import { StudentDocumentRepository } from '../../src/repositories/student-document.repository';
import { createTestApp } from '../core/app';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolUser,
} from '../support/school-session';
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createClassWithSection,
  createGuardian,
  createStudent,
  enrol,
  type TestStudent,
} from '../support/students';
import { guardianLogin } from '../diary/support';
import { EXIF_MARKER, gif, html, jpegWithExif, pdf, pixelBombPng, png, svg } from './fixtures';

const ORIGIN = new URL(loadEnv().APP_URL).origin;
const ID = /^[1-9][0-9]{0,18}$/;

interface Staged {
  id: string;
  mime: string;
  sizeBytes: number;
  expiresAt: string;
}
interface Doc {
  id: string;
  studentId: string;
  type: string;
  mime: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedByName: string | null;
  createdAt: string;
}
interface ErrorBody {
  error: {
    code: string;
    details: { reason?: string; fields?: { path: string; code: string }[] } | null;
  };
}

describe('uploads and documents (e2e)', () => {
  let app: NestExpressApplication;
  let school: TestSchool;
  let other: TestSchool;
  let officeUser: TestSchoolUser;
  let office: string;
  let office2: string;
  let otherOffice: string;
  let teacher: string;
  let student: TestStudent;
  let student2: TestStudent;
  const db = testDb();
  const http = () => request(app.getHttpServer());
  const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;

  const upload = (body: Buffer, cookie = office, filename = 'file.bin', contentType?: string) =>
    http()
      .post('/api/v1/uploads')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .attach('file', body, { filename, ...(contentType ? { contentType } : {}) });

  const stage = async (body: Buffer, cookie = office): Promise<Staged> => {
    const res = await upload(body, cookie);
    expect(res.status).toBe(201);
    return res.body as Staged;
  };

  const addDocument = (studentId: bigint, body: object, cookie = office) =>
    http()
      .post(`/api/v1/students/${studentId}/documents`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send(body);

  const download = (path: string, cookie = office) =>
    http().get(path).set('Cookie', cookie).responseType('blob');

  async function sessionFor(
    target: TestSchool,
    systemRole: 'office_staff' | 'teacher' | 'principal',
  ) {
    const user = await createSchoolUser(db, target, { systemRole });
    return { user, cookie: (await createSchoolSession(db, target, user)).cookie };
  }

  beforeAll(async () => {
    app = await createTestApp();
    school = await createSchool();
    other = await createSchool();
    office2 = (await sessionFor(school, 'office_staff')).cookie;
    otherOffice = (await sessionFor(other, 'office_staff')).cookie;
    teacher = (await sessionFor(school, 'teacher')).cookie;
    const { section } = await createClassWithSection(db, school);
    student = await createStudent(db, school);
    student2 = await createStudent(db, school);
    await enrol(db, school, student, section);
    await enrol(db, school, student2, section);
  });

  // A fresh office user per test: uploads are limited to 20 a minute per user.
  beforeEach(async () => {
    const o = await sessionFor(school, 'office_staff');
    officeUser = o.user;
    office = o.cookie;
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  describe('POST /uploads', () => {
    // R171 (contracts/slice-13.md §7) widened the route to diary.write and both announcement
    // capabilities, so a teacher may stage a file now; a guardian holds none of the four.
    it('401 without a session, 403 for a caller holding no upload capability (a guardian)', async () => {
      const anon = await http()
        .post('/api/v1/uploads')
        .set('Origin', ORIGIN)
        .attach('file', await png(), 'a.png');
      expect(anon.status).toBe(401);
      const guardian = await guardianLogin(db, school, await createGuardian(db, school));
      const res = await upload(await png(), guardian.cookie);
      expect(res.status).toBe(403);
    });

    it('R42: stores a JPEG re-encoded without its EXIF, under a ULID key in the school prefix', async () => {
      const input = await jpegWithExif();
      expect((await sharp(input).metadata()).exif).toBeDefined();
      expect(input.includes(EXIF_MARKER)).toBe(true);

      const res = await upload(input, office, 'holiday.jpg', 'image/jpeg');
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.stringMatching(ID),
        mime: 'image/jpeg',
        sizeBytes: expect.any(Number),
        expiresAt: expect.any(String),
      });
      const staged = res.body as Staged;
      // No object key, no URL: the key never leaves the server.
      expect(res.text).not.toContain(`${school.id}/`);
      const expiresIn = new Date(staged.expiresAt).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(23 * 3600_000);
      expect(expiresIn).toBeLessThanOrEqual(24 * 3600_000);

      const row = await db.stagedUpload.findFirst({
        where: { schoolId: school.id, id: BigInt(staged.id) },
      });
      expect(row?.objectKey).toMatch(new RegExp(`^${school.id}/[0-9A-HJKMNP-TV-Z]{26}\\.jpg$`));
      expect(row?.uploadedBy).toBe(officeUser.userId);
      expect(row?.consumedAt).toBeNull();

      const stored = await app.get(ObjectStorage).get(row?.objectKey ?? '');
      const chunks: Buffer[] = [];
      for await (const chunk of stored.body) chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBe(staged.sizeBytes);
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.exif).toBeUndefined();
      expect(bytes.includes(EXIF_MARKER)).toBe(false);
    });

    it('R42: accepts PNG and PDF by their bytes, whatever the declared type and name', async () => {
      const p = await upload(await png(), office, 'not-really.pdf', 'application/pdf');
      expect(p.status).toBe(201);
      expect((p.body as Staged).mime).toBe('image/png');
      const d = await upload(pdf(), office, 'scan.jpg', 'image/jpeg');
      expect(d.status).toBe(201);
      expect((d.body as Staged).mime).toBe('application/pdf');
      expect((d.body as Staged).sizeBytes).toBe(pdf().length);
    });

    it('R42: 415 for SVG, HTML and GIF, even when declared as an image', async () => {
      for (const [body, name] of [
        [svg(), 'logo.svg'],
        [html(), 'photo.jpg'],
        [await gif(), 'anim.gif'],
        [Buffer.from('just some text'), 'notes.png'],
      ] as const) {
        const res = await upload(body, office, name, 'image/jpeg');
        expect(res.status).toBe(415);
        expect(errorOf(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      }
    });

    it('R42: 415 image_rejected for a pixel bomb and for a truncated image', async () => {
      const bomb = await upload(await pixelBombPng(), office, 'bomb.png');
      expect(bomb.status).toBe(415);
      expect(errorOf(bomb).details?.reason).toBe('image_rejected');

      const whole = await jpegWithExif();
      const truncated = await upload(whole.subarray(0, Math.floor(whole.length / 2)), office);
      expect(truncated.status).toBe(415);
      expect(errorOf(truncated).details?.reason).toBe('image_rejected');
    });

    it('R42: 413 over 5 MB', async () => {
      const big = Buffer.concat([pdf(), Buffer.alloc(5 * 1024 * 1024)]);
      const res = await upload(big, office, 'big.pdf');
      expect(res.status).toBe(413);
      expect(errorOf(res).code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('422 without the file part, with another field, or with a JSON body', async () => {
      const noFile = await http()
        .post('/api/v1/uploads')
        .set('Cookie', office)
        .set('Origin', ORIGIN)
        .field('note', 'x');
      expect(noFile.status).toBe(422);

      const extra = await http()
        .post('/api/v1/uploads')
        .set('Cookie', office)
        .set('Origin', ORIGIN)
        .field('schoolId', '1')
        .attach('file', await png(), 'a.png');
      expect(extra.status).toBe(422);

      const wrongName = await http()
        .post('/api/v1/uploads')
        .set('Cookie', office)
        .set('Origin', ORIGIN)
        .attach('document', await png(), 'a.png');
      expect(wrongName.status).toBe(422);

      const two = await http()
        .post('/api/v1/uploads')
        .set('Cookie', office)
        .set('Origin', ORIGIN)
        .attach('file', await png(), 'a.png')
        .attach('file', await png(), 'b.png');
      expect(two.status).toBe(422);

      const json = await http()
        .post('/api/v1/uploads')
        .set('Cookie', office)
        .set('Origin', ORIGIN)
        .send({ file: 'aGVsbG8=' });
      expect(json.status).toBe(422);
      expect(errorOf(json).details?.fields?.[0]?.path).toBe('file');
    });

    it('R41: staged content has no read endpoint; even its uploader gets 404 on every GET', async () => {
      const staged = await stage(await png());
      for (const path of [
        '/api/v1/uploads',
        `/api/v1/uploads/${staged.id}`,
        `/api/v1/uploads/${staged.id}/content`,
        `/api/v1/uploads/${staged.id}/download`,
      ]) {
        const res = await http().get(path).set('Cookie', office);
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
      }
    });

    it('a JSON-only route still refuses multipart (the exception is POST /uploads alone)', async () => {
      const res = await http()
        .post(`/api/v1/students/${student.id}/documents`)
        .set('Cookie', office)
        .set('Origin', ORIGIN)
        .attach('file', await png(), 'a.png');
      expect(res.status).toBe(415);
    });

    it('429 after 20 uploads a minute by one user', async () => {
      const { cookie } = await sessionFor(school, 'office_staff');
      const body = pdf();
      for (let i = 0; i < 20; i++) expect((await upload(body, cookie)).status).toBe(201);
      const res = await upload(body, cookie);
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('a failed object write leaves no orphan: the row is expired at once and the sweep removes it', async () => {
      const storage = app.get(ObjectStorage, { strict: false });
      const put = jest.spyOn(storage, 'put').mockRejectedValueOnce(new Error('store down'));
      const del = jest.spyOn(storage, 'delete');
      try {
        const res = await upload(pdf());
        expect(res.status).toBe(500);
        const rows = await db.stagedUpload.findMany({
          where: { schoolId: school.id, uploadedBy: officeUser.userId },
        });
        expect(rows).toHaveLength(1);
        const [row] = rows;
        // The row was written before the object, and is now unusable and due for the sweep.
        expect(row?.expiresAt.getTime()).toBe((row?.createdAt.getTime() ?? 0) + 1);
        expect(row?.consumedAt).toBeNull();
        // The next sweep past the grace period removes it.
        const sweep = app.get(StagedUploadSweep, { strict: false });
        const result = await sweep.sweepSchool(
          school.id,
          new Date(Date.now() + SWEEP_GRACE_MS + 1000),
        );
        expect(result.failed).toBe(0);
        expect(del).toHaveBeenCalledWith(row?.objectKey);
        expect(await db.stagedUpload.count({ where: { schoolId: school.id, id: row?.id } })).toBe(
          0,
        );
      } finally {
        put.mockRestore();
        del.mockRestore();
      }
    });
  });

  describe('POST /students/:id/documents', () => {
    it('201 commits the staged object under the same key; a retry is 200 with the same document', async () => {
      const staged = await stage(await png());
      const key = (
        await db.stagedUpload.findFirst({ where: { schoolId: school.id, id: BigInt(staged.id) } })
      )?.objectKey;

      const res = await addDocument(student.id, { stagedUploadId: staged.id, type: 'photo' });
      expect(res.status).toBe(201);
      const doc = res.body as Doc;
      expect(doc).toEqual({
        id: expect.stringMatching(ID),
        studentId: student.id.toString(),
        type: 'photo',
        mime: 'image/png',
        sizeBytes: staged.sizeBytes,
        uploadedBy: officeUser.userId.toString(),
        uploadedByName: expect.any(String),
        createdAt: expect.any(String),
      });
      const row = await db.studentDocument.findFirst({
        where: { schoolId: school.id, id: BigInt(doc.id) },
      });
      expect(row?.objectKey).toBe(key);
      const consumed = await db.stagedUpload.findFirst({
        where: { schoolId: school.id, id: BigInt(staged.id) },
      });
      expect(consumed?.consumedAt).not.toBeNull();
      const audit = await db.auditLog.findFirst({
        where: { schoolId: school.id, action: 'document.added', subjectId: BigInt(doc.id) },
      });
      expect(audit?.subjectType).toBe('student_document');

      const again = await addDocument(student.id, { stagedUploadId: staged.id, type: 'photo' });
      expect(again.status).toBe(200);
      expect((again.body as Doc).id).toBe(doc.id);
      expect(
        await db.studentDocument.count({ where: { schoolId: school.id, objectKey: key ?? '' } }),
      ).toBe(1);
    });

    it('two racing commits of one staged upload make one document', async () => {
      const staged = await stage(pdf());
      const [a, b] = await Promise.all([
        addDocument(student.id, { stagedUploadId: staged.id, type: 'other' }),
        addDocument(student.id, { stagedUploadId: staged.id, type: 'other' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect((a.body as Doc).id).toBe((b.body as Doc).id);
    });

    it("R91: another user's, a consumed (for another student) or an expired staged id is 422", async () => {
      const mine = await stage(pdf(), office2);
      const foreign = await addDocument(student.id, { stagedUploadId: mine.id, type: 'other' });
      expect(foreign.status).toBe(422);
      expect(errorOf(foreign).details?.fields).toEqual([
        { path: 'stagedUploadId', code: 'REFERENCE_NOT_FOUND', message: expect.any(String) },
      ]);

      const used = await stage(pdf());
      expect(
        (await addDocument(student.id, { stagedUploadId: used.id, type: 'other' })).status,
      ).toBe(201);
      const elsewhere = await addDocument(student2.id, { stagedUploadId: used.id, type: 'other' });
      expect(elsewhere.status).toBe(422);

      const expired = await stage(pdf());
      await db.stagedUpload.update({
        where: { schoolId_id: { schoolId: school.id, id: BigInt(expired.id) } },
        data: {
          createdAt: new Date(Date.now() - 3 * 86_400_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const late = await addDocument(student.id, { stagedUploadId: expired.id, type: 'other' });
      expect(late.status).toBe(422);
      const row = await db.stagedUpload.findFirst({
        where: { schoolId: school.id, id: BigInt(expired.id) },
      });
      expect(row?.consumedAt).toBeNull();

      const unknown = await addDocument(student.id, {
        stagedUploadId: '999999999999',
        type: 'other',
      });
      expect(unknown.status).toBe(422);
    });

    it('a photo must be an image: a PDF as photo is 422 on type and stays unconsumed', async () => {
      const staged = await stage(pdf());
      const res = await addDocument(student.id, { stagedUploadId: staged.id, type: 'photo' });
      expect(res.status).toBe(422);
      expect(errorOf(res).details?.fields?.[0]?.path).toBe('type');
      const row = await db.stagedUpload.findFirst({
        where: { schoolId: school.id, id: BigInt(staged.id) },
      });
      expect(row?.consumedAt).toBeNull();
    });

    it('422 on a malformed body; 404 for an unknown student', async () => {
      const bad = await addDocument(student.id, { stagedUploadId: 'abc', type: 'passport' });
      expect(bad.status).toBe(422);
      const staged = await stage(pdf());
      const missing = await addDocument(999_999_999_999n, {
        stagedUploadId: staged.id,
        type: 'other',
      });
      expect(missing.status).toBe(404);
    });
  });

  describe('reading documents', () => {
    let photoId: string;
    let pdfId: string;
    let subject: TestStudent;

    beforeAll(async () => {
      subject = await createStudent(db, school);
      const first = await stage(await png(10, 10));
      await addDocument(subject.id, { stagedUploadId: first.id, type: 'photo' });
      const latest = await stage(await jpegWithExif());
      photoId = (
        (await addDocument(subject.id, { stagedUploadId: latest.id, type: 'photo' })).body as Doc
      ).id;
      const scan = await stage(pdf());
      pdfId = (
        (await addDocument(subject.id, { stagedUploadId: scan.id, type: 'b_form' })).body as Doc
      ).id;
    });

    it('lists newest first, filters by type, pages', async () => {
      const all = await http()
        .get(`/api/v1/students/${subject.id}/documents`)
        .set('Cookie', office);
      expect(all.status).toBe(200);
      const page = all.body as { data: Doc[]; total: number; page: number; limit: number };
      expect(page.total).toBe(3);
      expect(page.data.map((d) => d.id)[0]).toBe(pdfId);
      expect(all.text).not.toContain(`${school.id}/`);

      const photos = await http()
        .get(`/api/v1/students/${subject.id}/documents?type=photo&limit=1`)
        .set('Cookie', office);
      expect((photos.body as { data: Doc[]; total: number }).total).toBe(2);
      expect((photos.body as { data: Doc[] }).data.map((d) => d.id)).toEqual([photoId]);

      const bad = await http()
        .get(`/api/v1/students/${subject.id}/documents?sort=createdAt`)
        .set('Cookie', office);
      expect(bad.status).toBe(422);
    });

    it('streams content as an attachment with nosniff and a sandbox CSP', async () => {
      const res = await download(`/api/v1/documents/${pdfId}/content`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="b_form-${pdfId}.pdf"`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe('sandbox');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-length']).toBe(String(pdf().length));
      expect(Buffer.compare(res.body as Buffer, pdf())).toBe(0);
    });

    it('GET /students/:id/photo is the latest photo; 404 when the student has none', async () => {
      const res = await download(`/api/v1/students/${subject.id}/photo`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="photo-${photoId}.jpg"`,
      );
      expect((await sharp(res.body as Buffer).metadata()).exif).toBeUndefined();

      const none = await http().get(`/api/v1/students/${student2.id}/photo`).set('Cookie', office);
      expect(none.status).toBe(404);
    });

    it('R43: another school gets 404 on every route; a teacher (no document.view) gets 403', async () => {
      for (const path of [
        `/api/v1/documents/${pdfId}/content`,
        `/api/v1/students/${subject.id}/photo`,
        `/api/v1/students/${subject.id}/documents`,
      ]) {
        const res = await http().get(path).set('Cookie', otherOffice);
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
        expect((await http().get(path).set('Cookie', teacher)).status).toBe(403);
      }
      const staged = await stage(pdf(), otherOffice);
      const cross = await addDocument(
        subject.id,
        { stagedUploadId: staged.id, type: 'other' },
        otherOffice,
      );
      expect(cross.status).toBe(404);
      expect((await http().get('/api/v1/documents/abc/content').set('Cookie', office)).status).toBe(
        404,
      );
    });

    it('a key outside the school prefix is never served (500, logged)', async () => {
      // The CHECK forbids such a row, so the guard is reached only through a corrupted read. Mock
      // the repository read to prove the service refuses rather than streams.
      // On the prototype: two modules provide the repository, so app.get may return either.
      const spy = jest.spyOn(StudentDocumentRepository.prototype, 'findById').mockResolvedValueOnce({
        id: 1n,
        studentId: subject.id,
        type: 'other',
        objectKey: `${other.id}/01J00000000000000000000000.pdf`,
        mime: 'application/pdf',
        sizeBytes: 10,
        uploadedBy: officeUser.userId,
        uploadedByName: null,
        createdAt: new Date(),
      });
      const res = await http().get(`/api/v1/documents/${pdfId}/content`).set('Cookie', office);
      spy.mockRestore();
      expect(res.status).toBe(500);
    });

    it('a document whose object is missing is the generic 500, not an unhandled error', async () => {
      const storage = app.get(ObjectStorage, { strict: false });
      const spy = jest.spyOn(storage, 'get').mockRejectedValueOnce(new ObjectNotFoundError());
      const logged = jest.spyOn(Logger.prototype, 'error');
      const res = await http().get(`/api/v1/documents/${pdfId}/content`).set('Cookie', office);
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(errorOf(res).code).toBe('INTERNAL_ERROR');
      // Caught and logged by the service, by document id only.
      expect(logged).toHaveBeenCalledWith(
        { documentId: pdfId },
        'document object missing from storage',
      );
      logged.mockRestore();
    });
  });
});

describe('uploads under load (e2e)', () => {
  it('503 when no re-encode slot frees within the wait', async () => {
    const app = await createTestApp({
      overrides: [{ provide: REENCODE_LIMIT, useValue: new ConcurrencyLimit(0, 20) }],
    });
    try {
      const db = testDb();
      const school = await createSchool();
      const user = await createSchoolUser(db, school, { systemRole: 'office_staff' });
      const { cookie } = await createSchoolSession(db, school, user);
      const res = await request(app.getHttpServer())
        .post('/api/v1/uploads')
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .attach('file', await png(), 'a.png');
      expect(res.status).toBe(503);
      expect((res.body as ErrorBody).error.code).toBe('SERVICE_UNAVAILABLE');
      // A PDF is not re-encoded and does not wait for a slot.
      const doc = await request(app.getHttpServer())
        .post('/api/v1/uploads')
        .set('Cookie', cookie)
        .set('Origin', ORIGIN)
        .attach('file', pdf(), 'a.pdf');
      expect(doc.status).toBe(201);
    } finally {
      await app.close();
      await closeTestDb();
    }
  });
});
