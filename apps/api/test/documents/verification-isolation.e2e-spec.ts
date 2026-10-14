// Control 4 / R62 for slice 40's reads and the one write of student_documents
// (contracts/slice-40.md §2): the queue, the decision, the newest row per type (the checklist and
// the list badge) and the incomplete-admissions report each see only their own school. The raw
// statements (RAW_SQL_FILES) filter school_id on every table they read.
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { StudentDocumentRepository } from '../../src/repositories/student-document.repository';
import type { SchoolId } from '../../src/tenancy/school-id';
import type { Scope } from '../../src/tenancy/scope';
import { Capability } from '@asms/shared';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { expectIsolated } from '../support/isolation';
import { createSchoolUser } from '../support/school-session';
import { closeTestDb, createSchool, createTwoSchools, testDb } from '../support/schools';
import { createClassWithSection, createSection, createStudent, createTeacherAssignment, day, enrol, isoDay } from '../support/students';

const db = () => testDb();
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('slice 40 tenant isolation', () => {
  let app: NestExpressApplication;
  let documents: StudentDocumentRepository;
  const as = <T>(schoolId: SchoolId, fn: () => Promise<T>) => asSchool(app, schoolId, fn);
  /** A school-wide scope, from a principal's document.verify (only the tenant key keeps rows apart). */
  let all: Scope;

  beforeAll(async () => {
    app = await createTestApp();
    documents = app.get(StudentDocumentRepository, { strict: false });
    const school = await createSchool();
    const principal = await createSchoolUser(db(), school, { systemRole: 'principal' });
    const permissions = app.get(PermissionsService, { strict: false });
    const access = await permissions.load(school.id, principal.userId);
    const scope = access && (await permissions.can(school.id, access, Capability.DOCUMENT_VERIFY));
    if (!scope || scope.kind !== 'all') throw new Error('expected a school-wide scope');
    all = scope;
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** A school's enrolled student with one uploaded B-Form, and a second staff member to decide it. */
  const world = async (schoolId: SchoolId) => {
    const school = { id: schoolId, shortCode: '' };
    const uploader = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const decider = await createSchoolUser(db(), school, { systemRole: 'office_staff' });
    const { section } = await createClassWithSection(db(), school);
    const student = await createStudent(db(), school);
    await enrol(db(), school, student, section);
    const row = await db().studentDocument.create({
      data: {
        schoolId,
        studentId: student.id,
        type: 'b_form',
        objectKey: `${schoolId}/01J${Array.from({ length: 23 }, () => CROCKFORD[randomInt(0, 32)]).join('')}.pdf`,
        mime: 'application/pdf',
        sizeBytes: 10,
        uploadedBy: uploader.userId,
      },
    });
    return { student, decider, section, documentId: row.id };
  };

  it('the queue and the decision see only their own school', async () => {
    const two = await createTwoSchools();
    let decider = 0n;
    await expectIsolated(two, {
      create: async (schoolId) => {
        const w = await world(schoolId);
        decider = w.decider.userId;
        return w.documentId;
      },
      read: (schoolId, id) => as(schoolId, () => documents.findById(schoolId, all, id)),
      list: async (schoolId) =>
        (await as(schoolId, () => documents.listQueue(schoolId, all, { status: 'uploaded', sort: 'createdAt', skip: 0, take: 50 }))).rows,
      write: (schoolId, id) =>
        as(schoolId, () => documents.decide(schoolId, id, { status: 'verified', by: decider, at: new Date(), reason: null })),
      snapshot: (row) => (row as { status: string }).status,
    });
  });

  it('the newest row per type and the incomplete-admissions report see only their own school', async () => {
    const { a, b } = await createTwoSchools();
    const w = await world(a.id);
    const newestA = await as(a.id, () => documents.newestOfTypes(a.id, all, [w.student.id], ['b_form', 'photo']));
    expect(newestA.map((r) => [r.studentId, r.type, r.status])).toEqual([[w.student.id, 'b_form', 'uploaded']]);
    expect(await as(b.id, () => documents.newestOfTypes(b.id, all, [w.student.id], ['b_form', 'photo']))).toEqual([]);
    expect(await as(b.id, () => documents.newestForStudent(b.id, all, w.student.id, ['b_form']))).toEqual([]);
    expect((await as(a.id, () => documents.newestForStudent(a.id, all, w.student.id, ['b_form']))).map((r) => r.id)).toEqual([w.documentId]);

    const report = (schoolId: SchoolId) =>
      as(schoolId, () =>
        documents.incompleteAdmissions(schoolId, all, {
          from: day(isoDay(-30)),
          to: day(isoDay()),
          types: ['b_form', 'photo'],
          sort: 'admittedOn',
          skip: 0,
          take: 50,
        }),
      );
    expect((await report(a.id)).rows.map((r) => r.studentId)).toContainEqual(w.student.id);
    expect((await report(b.id)).rows.map((r) => r.studentId)).not.toContainEqual(w.student.id);
  });

  it("security L1 (fix round): the badge's newest row per type is read through the caller's row scope", async () => {
    const school = await createSchool();
    const w = await world(school.id);
    const other = await createSection(db(), school, { id: w.section.classId, academicYearId: w.section.academicYearId }, { name: 'Z' });
    const permissions = app.get(PermissionsService, { strict: false });
    /** A class teacher's student.view scope: their section only. */
    const scopeOfTeacher = async (section: typeof w.section): Promise<Scope> => {
      const teacher = await createSchoolUser(db(), school, { systemRole: 'teacher' });
      await createTeacherAssignment(db(), school, teacher, {
        role: 'class_teacher',
        section,
        startsOn: isoDay(-30),
      });
      const access = await permissions.load(school.id, teacher.userId);
      const scope = access && (await permissions.can(school.id, access, Capability.STUDENT_VIEW));
      if (!scope || scope.kind !== 'sections') throw new Error('expected a section scope');
      return scope;
    };
    const newest = (scope: Scope) => as(school.id, () => documents.newestOfTypes(school.id, scope, [w.student.id], ['b_form', 'photo']));
    expect((await newest(await scopeOfTeacher(w.section))).map((r) => r.studentId)).toEqual([w.student.id]);
    expect(await newest(await scopeOfTeacher(other))).toEqual([]);
  });
});
