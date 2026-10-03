// Guardian links (contracts/slice-6.md §4; R28-R30) and enrolments (§5; R37-R39) end to end, over
// the real AppModule, access guard and database.
import { closeTestDb, createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createClassWithSection,
  createGuardian,
  createSection,
  createStudent,
  day,
  enrol,
  isoDay,
  linkGuardian,
} from '../support/students';
import { admitted, auditFor, createHarness, errorOf, signIn, type Harness } from './support';

interface Link {
  id: string;
  guardianId: string;
  guardianFullName: string;
  relationship: string;
  isPrimaryContact: boolean;
  isFeePayer: boolean;
  canLogin: boolean;
  phone: string | null;
  endedAt: string | null;
  contactCapability: string | null;
  guardianCnicMasked: string | null;
}
interface Enrolment {
  id: string;
  studentId: string;
  classId: string;
  sectionId: string;
  sectionName: string;
  rollNo: number | null;
  status: string;
  startedOn: string;
  endedOn: string | null;
}
interface Page<T> {
  data: T[];
  total: number;
}

describe('guardian links and enrolments (e2e)', () => {
  let h: Harness;
  const db = testDb();

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.app.close();
    await closeTestDb();
  });

  async function setup() {
    const school = await createSchool();
    const office = await signIn(school, 'office_staff');
    const structure = await createClassWithSection(db, school);
    const admission = await admitted(school, structure.section);
    return { school, office, ...structure, ...admission };
  }

  const links = async (studentId: bigint, cookie: string, query = '') =>
    ((await h.get(`/students/${studentId}/guardian-links${query}`, cookie)).body as Page<Link>)
      .data;
  const liveFlags = async (school: TestSchool, studentId: bigint) =>
    (
      await db.studentGuardian.findMany({
        where: { schoolId: school.id, studentId, endedAt: null },
        orderBy: { id: 'asc' },
      })
    ).map((l) => ({ id: l.id, primary: l.isPrimaryContact, payer: l.isFeePayer }));

  // ------------------------------------------------------------------------ guardian links

  it('creates a link (201, audited) with the masked CNIC for guardian.manage', async () => {
    const { school, office, student, guardian } = await setup();
    const mother = await createGuardian(db, school, { fullName: 'Amna Bibi' });
    const res = await h.send(
      'post',
      `/students/${student.id}/guardian-links`,
      {
        guardianId: mother.id.toString(),
        relationship: 'mother',
        isPrimaryContact: false,
        isFeePayer: false,
        canLogin: true,
      },
      office.cookie,
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      studentId: student.id.toString(),
      guardianId: mother.id.toString(),
      guardianFullName: 'Amna Bibi',
      relationship: 'mother',
      isPrimaryContact: false,
      isFeePayer: false,
      canLogin: true,
      phone: mother.phone,
      endedAt: null,
      contactCapability: 'whatsapp',
      guardianCnicMasked: `${(mother.cnic ?? '').slice(0, 5)}-*****-${(mother.cnic ?? '').slice(12)}`,
      guardianUserId: null,
    });
    expect(res.text).not.toContain(mother.cnic ?? 'x');
    const [audit] = await auditFor(school, 'student_guardian', (res.body as Link).id);
    expect(audit).toMatchObject({
      action: 'guardian_link.created',
      metadata: { studentId: student.id.toString(), guardianId: mother.id.toString() },
    });
    // Primary first, then by guardian name.
    expect((await links(student.id, office.cookie)).map((l) => l.guardianId)).toEqual([
      guardian.id.toString(),
      mother.id.toString(),
    ]);
  });

  it('create refusals: unknown or merged guardian, live link exists, primary without a phone', async () => {
    const { school, office, student, guardian } = await setup();
    const path = `/students/${student.id}/guardian-links`;
    const body = (guardianId: bigint | string, extra: object = {}) => ({
      guardianId: guardianId.toString(),
      relationship: 'guardian',
      isPrimaryContact: false,
      isFeePayer: false,
      canLogin: false,
      ...extra,
    });

    const unknown = await h.send('post', path, body('999999999999'), office.cookie);
    expect(unknown.status).toBe(422);
    expect(errorOf(unknown).details).toMatchObject({
      fields: [{ path: 'guardianId', code: 'REFERENCE_NOT_FOUND' }],
    });

    const survivor = await createGuardian(db, school);
    const merged = await createGuardian(db, school);
    await db.guardian.update({
      where: { schoolId_id: { schoolId: school.id, id: merged.id } },
      data: { status: 'merged', mergedIntoId: survivor.id },
    });
    expect(errorOf(await h.send('post', path, body(merged.id), office.cookie))).toMatchObject({
      code: 'GUARDIAN_MERGED',
      details: { mergedIntoId: survivor.id.toString() },
    });

    const existing = await links(student.id, office.cookie);
    expect(errorOf(await h.send('post', path, body(guardian.id), office.cookie))).toMatchObject({
      code: 'GUARDIAN_LINK_EXISTS',
      details: { linkId: existing[0]?.id },
    });

    const phoneless = await createGuardian(db, school, { phone: null });
    expect(
      errorOf(
        await h.send('post', path, body(phoneless.id, { isPrimaryContact: true }), office.cookie),
      ).code,
    ).toBe('PRIMARY_CONTACT_NEEDS_PHONE');
    // Without primary it may be linked.
    expect((await h.send('post', path, body(phoneless.id), office.cookie)).status).toBe(201);

    for (const bad of [
      { ...body(survivor.id), relationship: 'uncle' },
      { ...body(survivor.id), isPrimaryContact: null },
      { relationship: 'father', isPrimaryContact: false, isFeePayer: false, canLogin: false },
      { ...body(survivor.id), schoolId: '1' },
    ]) {
      expect((await h.send('post', path, bad, office.cookie)).status).toBe(422);
    }
  });

  it('R28: a new primary contact replaces the old one in the same transaction', async () => {
    const { school, office, student, guardian } = await setup();
    const mother = await createGuardian(db, school);
    const res = await h.send(
      'post',
      `/students/${student.id}/guardian-links`,
      {
        guardianId: mother.id.toString(),
        relationship: 'mother',
        isPrimaryContact: true,
        isFeePayer: false,
        canLogin: false,
      },
      office.cookie,
    );
    expect(res.status).toBe(201);
    const all = await links(student.id, office.cookie);
    expect(all.filter((l) => l.isPrimaryContact).map((l) => l.guardianId)).toEqual([
      mother.id.toString(),
    ]);
    expect(all.find((l) => l.guardianId === guardian.id.toString())).toMatchObject({
      isPrimaryContact: false,
    });
  });

  it('R28 under concurrency: two links made primary at once leave exactly one primary', async () => {
    const { school, office, student } = await setup();
    const one = await linkGuardian(db, school, student, await createGuardian(db, school), {
      isPrimaryContact: false,
    });
    const two = await linkGuardian(db, school, student, await createGuardian(db, school), {
      isPrimaryContact: false,
    });
    const results = await Promise.all(
      [one, two].map((l) =>
        h.send('patch', `/guardian-links/${l.id}`, { isPrimaryContact: true }, office.cookie),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const primaries = (await links(student.id, office.cookie)).filter((l) => l.isPrimaryContact);
    expect(primaries).toHaveLength(1);
  });

  it('PATCH: flags and relationship, audited; R28, R29 and R30 refusals; null is 422', async () => {
    const { school, office, student, link } = await setup();
    const phoneless = await createGuardian(db, school, { phone: null });
    const second = await linkGuardian(db, school, student, phoneless, {
      isPrimaryContact: false,
      isFeePayer: false,
    });
    const patch = (id: bigint, body: object) =>
      h.send('patch', `/guardian-links/${id}`, body, office.cookie);

    expect(errorOf(await patch(link.id, { isPrimaryContact: false })).code).toBe(
      'PRIMARY_CONTACT_REQUIRED',
    );
    expect(errorOf(await patch(link.id, { isFeePayer: false })).code).toBe('FEE_PAYER_REQUIRED');
    expect(errorOf(await patch(second.id, { isPrimaryContact: true })).code).toBe(
      'PRIMARY_CONTACT_NEEDS_PHONE',
    );
    for (const body of [{ relationship: null }, { canLogin: null }, { isFeePayer: 'yes' }]) {
      expect((await patch(second.id, body)).status).toBe(422);
    }

    const res = await patch(second.id, { relationship: 'other', isFeePayer: true, canLogin: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      relationship: 'other',
      isFeePayer: true,
      canLogin: true,
      isPrimaryContact: false,
    });
    // Now the first may stop paying: another fee payer remains (R29).
    expect((await patch(link.id, { isFeePayer: false })).status).toBe(200);
    // Unchanged: no write, no audit.
    await patch(second.id, { relationship: 'other' });
    const audits = await auditFor(school, 'student_guardian', second.id);
    expect(audits.map((a) => a.action)).toEqual(['guardian_link.updated']);
    expect(audits[0]?.metadata).toEqual({
      changes: {
        relationship: { from: 'father', to: 'other' },
        isFeePayer: { from: false, to: true },
        canLogin: { from: false, to: true },
      },
    });
    expect(await liveFlags(school, student.id)).toEqual([
      { id: link.id, primary: true, payer: false },
      { id: second.id, primary: false, payer: true },
    ]);
  });

  it('end: primary and last fee payer are refused; ending twice is a 200 with one audit row', async () => {
    const { school, office, student, link } = await setup();
    const other = await createGuardian(db, school);
    const second = await linkGuardian(db, school, student, other, {
      isPrimaryContact: false,
      isFeePayer: false,
    });
    const end = (id: bigint, reason = 'No longer responsible') =>
      h.send('post', `/guardian-links/${id}/end`, { reason }, office.cookie);

    expect(errorOf(await end(link.id)).code).toBe('PRIMARY_CONTACT_REQUIRED');
    expect((await end(second.id, 'no')).status).toBe(422);
    const ended = await end(second.id);
    expect(ended.status).toBe(200);
    expect((ended.body as Link).endedAt).not.toBeNull();
    expect((await end(second.id)).status).toBe(200);
    const audits = await auditFor(school, 'student_guardian', second.id);
    expect(audits.map((a) => [a.action, a.reason])).toEqual([
      ['guardian_link.ended', 'No longer responsible'],
    ]);
    expect(
      errorOf(
        await h.send('patch', `/guardian-links/${second.id}`, { canLogin: true }, office.cookie),
      ).code,
    ).toBe('GUARDIAN_LINK_ENDED');

    // The primary moves to a new link, then the old one may end, unless it is the last fee payer.
    const third = await linkGuardian(db, school, student, await createGuardian(db, school), {
      isPrimaryContact: false,
      isFeePayer: false,
    });
    await h.send('patch', `/guardian-links/${third.id}`, { isPrimaryContact: true }, office.cookie);
    expect(errorOf(await end(link.id)).code).toBe('FEE_PAYER_REQUIRED');

    expect((await links(student.id, office.cookie)).map((l) => l.id)).toEqual([
      third.id.toString(),
      link.id.toString(),
    ]);
    expect(await links(student.id, office.cookie, '?includeEnded=true')).toHaveLength(3);
  });

  it('link routes 404 another school’s link; a teacher may not write links', async () => {
    const { school, link } = await setup();
    const intruder = await signIn(await createSchool(), 'principal');
    expect(
      (await h.send('patch', `/guardian-links/${link.id}`, { canLogin: true }, intruder.cookie))
        .status,
    ).toBe(404);
    expect(
      (
        await h.send(
          'post',
          `/guardian-links/${link.id}/end`,
          { reason: 'Intrusion' },
          intruder.cookie,
        )
      ).status,
    ).toBe(404);
    const teacher = await signIn(school, 'teacher');
    expect(
      (await h.send('patch', `/guardian-links/${link.id}`, { canLogin: true }, teacher.cookie))
        .status,
    ).toBe(403);
  });

  // ----------------------------------------------------------------------------- enrolments

  it('lists enrolments newest first', async () => {
    const { school, office, klass, section } = await setup();
    const student = await createStudent(db, school, { admittedOn: isoDay(-60) });
    const old = await enrol(db, school, student, section, {
      status: 'left',
      startedOn: isoDay(-60),
      endedOn: isoDay(-30),
    });
    const other = await createSection(db, school, klass);
    const current = await enrol(db, school, student, other, { startedOn: isoDay(-30), rollNo: 4 });
    const res = await h.get(`/students/${student.id}/enrolments`, office.cookie);
    expect(res.body).toMatchObject({ total: 2 });
    const rows = (res.body as Page<Enrolment>).data;
    expect(rows.map((r) => r.id)).toEqual([current.id.toString(), old.id.toString()]);
    expect(rows[0]).toMatchObject({
      status: 'active',
      rollNo: 4,
      startedOn: isoDay(-30),
      endedOn: null,
      sectionId: other.id.toString(),
    });
    expect(rows[1]).toMatchObject({ status: 'left', endedOn: isoDay(-30) });
  });

  it('R37: PATCH rollNo sets, clears and refuses a taken number; 1-9999 only', async () => {
    const { school, office, section, enrolment } = await setup();
    const peer = await admitted(school, section, { rollNo: 7 });
    const patch = (body: object) =>
      h.send('patch', `/enrolments/${enrolment.id}`, body, office.cookie);

    const taken = await patch({ rollNo: 7 });
    expect(taken.status).toBe(409);
    expect(errorOf(taken)).toMatchObject({
      code: 'ROLL_NO_TAKEN',
      details: { enrolmentId: peer.enrolment.id.toString() },
    });
    expect((await patch({ rollNo: 8 })).body).toMatchObject({ rollNo: 8 });
    expect((await patch({ rollNo: null })).body).toMatchObject({ rollNo: null });
    for (const body of [{}, { rollNo: 0 }, { rollNo: 10000 }, { rollNo: 1.5 }, { rollNo: '3' }]) {
      expect((await patch(body)).status).toBe(422);
    }
    const audits = await auditFor(school, 'enrolment', enrolment.id);
    expect(audits.map((a) => a.metadata)).toEqual([
      { from: null, to: 8 },
      { from: 8, to: null },
    ]);
    // A left enrolment's number is free again (the unique index covers active rows only).
    await db.enrolment.update({
      where: { schoolId_id: { schoolId: school.id, id: peer.enrolment.id } },
      data: { status: 'left', endedOn: day(isoDay()) },
    });
    expect((await patch({ rollNo: 7 })).body).toMatchObject({ rollNo: 7 });
    const notActive = await h.send(
      'patch',
      `/enrolments/${peer.enrolment.id}`,
      { rollNo: 9 },
      office.cookie,
    );
    expect(errorOf(notActive).code).toBe('ENROLMENT_NOT_ACTIVE');
  });

  it('R37 under concurrency: one roll number, two enrolments at once, one wins', async () => {
    const { school, office, section, enrolment } = await setup();
    const peer = await admitted(school, section);
    const results = await Promise.all(
      [enrolment.id, peer.enrolment.id].map((id) =>
        h.send('patch', `/enrolments/${id}`, { rollNo: 12 }, office.cookie),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const lost = results.find((r) => r.status === 409);
    expect(lost && errorOf(lost).code).toBe('ROLL_NO_TAKEN');
  });

  it('change-section: in place, roll number cleared; same section unchanged; other class 422', async () => {
    const { school, office, klass, section, enrolment } = await setup();
    await db.enrolment.update({
      where: { schoolId_id: { schoolId: school.id, id: enrolment.id } },
      data: { rollNo: 3 },
    });
    const target = await createSection(db, school, klass, { name: 'B' });
    const path = `/enrolments/${enrolment.id}/change-section`;

    const same = await h.send('post', path, { sectionId: section.id.toString() }, office.cookie);
    expect(same.body).toMatchObject({ sectionId: section.id.toString(), rollNo: 3 });
    const res = await h.send(
      'post',
      path,
      { sectionId: target.id.toString(), reason: 'Balance sizes' },
      office.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: enrolment.id.toString(),
      sectionId: target.id.toString(),
      sectionName: 'B',
      rollNo: null,
      status: 'active',
    });
    const audits = await auditFor(school, 'enrolment', enrolment.id);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'enrolment.section_changed',
        reason: 'Balance sizes',
        metadata: { fromSectionId: section.id.toString(), toSectionId: target.id.toString() },
      }),
    ]);

    const otherClass = await createClass(db, school, { id: klass.academicYearId });
    const foreign = await createSection(db, school, otherClass);
    const refused = await h.send('post', path, { sectionId: foreign.id.toString() }, office.cookie);
    expect(refused.status).toBe(422);
    expect(errorOf(refused).details).toMatchObject({
      fields: [{ path: 'sectionId', code: 'INVALID_VALUE' }],
    });
    const archived = await createSection(db, school, klass, { deletedAt: new Date() });
    expect(
      errorOf(await h.send('post', path, { sectionId: archived.id.toString() }, office.cookie))
        .code,
    ).toBe('SECTION_ARCHIVED');
    expect((await h.send('post', path, { sectionId: '999999999999' }, office.cookie)).status).toBe(
      422,
    );
  });

  it('R38, R39: change-class closes the old enrolment and opens a new one, in-year only', async () => {
    const { school, office, year, section } = await setup();
    const student = await createStudent(db, school, { admittedOn: isoDay(-20) });
    const enrolment = await enrol(db, school, student, section, {
      startedOn: isoDay(-20),
      rollNo: 5,
    });
    const path = `/enrolments/${enrolment.id}/change-class`;
    const target = await createClass(db, school, year);
    const targetSection = await createSection(db, school, target);
    const body = (extra: object = {}) => ({
      classId: target.id.toString(),
      sectionId: targetSection.id.toString(),
      effectiveOn: isoDay(-5),
      reason: 'Promoted mid-year',
      ...extra,
    });

    const nextYear = await createAcademicYear(db, school);
    const elsewhere = await createClass(db, school, nextYear);
    const elsewhereSection = await createSection(db, school, elsewhere);
    expect(
      errorOf(
        await h.send(
          'post',
          path,
          body({ classId: elsewhere.id.toString(), sectionId: elsewhereSection.id.toString() }),
          office.cookie,
        ),
      ).code,
    ).toBe('CLASS_IN_OTHER_YEAR');
    expect(
      (await h.send('post', path, body({ classId: section.classId.toString() }), office.cookie))
        .status,
    ).toBe(422);
    expect(
      (await h.send('post', path, body({ effectiveOn: isoDay(-21) }), office.cookie)).status,
    ).toBe(422);
    expect(
      (await h.send('post', path, body({ effectiveOn: isoDay(2) }), office.cookie)).status,
    ).toBe(422);
    expect(
      (await h.send('post', path, body({ sectionId: section.id.toString() }), office.cookie))
        .status,
    ).toBe(422);
    const archivedClass = await createClass(db, school, year, { status: 'archived' });
    const archivedSection = await createSection(db, school, archivedClass);
    expect(
      errorOf(
        await h.send(
          'post',
          path,
          body({ classId: archivedClass.id.toString(), sectionId: archivedSection.id.toString() }),
          office.cookie,
        ),
      ).code,
    ).toBe('CLASS_ARCHIVED');

    const res = await h.send('post', path, body(), office.cookie);
    expect(res.status).toBe(200);
    const created = res.body as Enrolment;
    expect(created).toMatchObject({
      studentId: student.id.toString(),
      classId: target.id.toString(),
      sectionId: targetSection.id.toString(),
      rollNo: null,
      status: 'active',
      startedOn: isoDay(-5),
      endedOn: null,
    });
    expect(created.id).not.toBe(enrolment.id.toString());
    const old = await db.enrolment.findFirst({ where: { schoolId: school.id, id: enrolment.id } });
    expect(old).toMatchObject({
      status: 'left',
      endedOn: day(isoDay(-5)),
      classId: section.classId,
      rollNo: 5,
    });
    const [audit] = await auditFor(school, 'enrolment', enrolment.id);
    expect(audit).toMatchObject({
      action: 'enrolment.class_changed',
      reason: 'Promoted mid-year',
      metadata: { newEnrolmentId: created.id, toClassId: target.id.toString() },
    });
    // Retry: the old enrolment is no longer active.
    expect(errorOf(await h.send('post', path, body(), office.cookie)).code).toBe(
      'ENROLMENT_NOT_ACTIVE',
    );
    expect(
      (
        (await h.get(`/students/${student.id}`, office.cookie)).body as {
          current: { enrolmentId: string };
        }
      ).current.enrolmentId,
    ).toBe(created.id);
  });

  it('enrolment routes 404 another school’s enrolment and an out-of-scope id', async () => {
    const { enrolment } = await setup();
    const intruder = await signIn(await createSchool(), 'principal');
    for (const [path, body] of [
      [`/enrolments/${enrolment.id}/change-section`, { sectionId: '1' }],
      [
        `/enrolments/${enrolment.id}/change-class`,
        { classId: '1', sectionId: '1', effectiveOn: isoDay(), reason: 'Intrusion' },
      ],
    ] as const) {
      expect((await h.send('post', path, body, intruder.cookie)).status).toBe(404);
    }
    expect(
      (await h.send('patch', `/enrolments/${enrolment.id}`, { rollNo: 1 }, intruder.cookie)).status,
    ).toBe(404);
  });
});
