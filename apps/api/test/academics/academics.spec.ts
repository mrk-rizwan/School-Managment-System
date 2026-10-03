// Slice 3 behaviour at the service layer (contracts/slice-3.md), on the real database. The HTTP
// surface (access decorators, validation, envelopes) is in academics.e2e-spec.ts.
import { ErrorCode } from '@asms/shared';
import { closeTestDb, testDb } from '../support/schools';
import { actAsNewSchool, auditFor, createAcademics, refusal, tag, type Academics } from './support';

describe('academic structure services', () => {
  let a: Academics;

  beforeAll(async () => {
    a = await createAcademics();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await a.close();
    await closeTestDb();
  });

  const year = (body: Partial<{ name: string; startsOn: string; endsOn: string }> = {}) =>
    a.years.create({
      name: `Y ${tag()}`,
      startsOn: '2026-04-01',
      endsOn: '2027-03-31',
      ...body,
    });

  const klass = async (academicYearId?: string, name = `C ${tag()}`) =>
    a.classes.create({
      academicYearId: academicYearId ?? (await year()).id,
      name,
      attendanceMode: 'daily',
    });

  it('refuses to run without a resolved session (fails closed)', async () => {
    a.ctx.schoolId = undefined;
    a.ctx.userId = undefined;
    expect(await refusal(a.years.list({ page: 1, limit: 25 }))).toMatchObject({
      status: 401,
      code: ErrorCode.AUTH_REQUIRED,
    });
  });

  describe('academic years', () => {
    it('creates a planned year and audits it', async () => {
      const school = await actAsNewSchool(a);
      const created = await year({ name: '2026-27' });
      expect(created).toMatchObject({
        name: '2026-27',
        startsOn: '2026-04-01',
        endsOn: '2027-03-31',
        status: 'planned',
      });
      const [row] = await auditFor(school.id, 'academic_year', created.id);
      expect(row).toMatchObject({
        action: 'academic_year.created',
        actorUserId: school.userId,
        metadata: { name: '2026-27', startsOn: '2026-04-01', endsOn: '2027-03-31' },
      });
    });

    it('checks the dates: endsOn after startsOn, span at most 731 days', async () => {
      await actAsNewSchool(a);
      for (const endsOn of ['2026-04-01', '2026-03-31', '2028-04-02']) {
        const error = await refusal(year({ endsOn }));
        expect(error).toMatchObject({
          status: 422,
          details: { fields: [{ path: 'endsOn', code: ErrorCode.INVALID_VALUE }] },
        });
      }
      // Exactly 731 days is allowed.
      await expect(year({ endsOn: '2028-04-01' })).resolves.toMatchObject({ endsOn: '2028-04-01' });
    });

    it('refuses a taken name (ACADEMIC_YEAR_NAME_TAKEN); another school may use it', async () => {
      await actAsNewSchool(a);
      await year({ name: '2030-31' });
      expect(await refusal(year({ name: '2030-31' }))).toMatchObject({
        status: 409,
        code: ErrorCode.ACADEMIC_YEAR_NAME_TAKEN,
        details: { field: 'name' },
      });
      await actAsNewSchool(a);
      await expect(year({ name: '2030-31' })).resolves.toMatchObject({ name: '2030-31' });
    });

    it('PATCH checks dates on the merged result and audits only real changes', async () => {
      const school = await actAsNewSchool(a);
      const created = await year();
      expect(
        await refusal(a.years.update(BigInt(created.id), { startsOn: '2027-04-01' })),
      ).toMatchObject({
        status: 422,
      });
      const same = await a.years.update(BigInt(created.id), { name: created.name });
      expect(same.updatedAt).toEqual(created.updatedAt);
      const updated = await a.years.update(BigInt(created.id), { endsOn: '2027-04-30' });
      expect(updated.endsOn).toBe('2027-04-30');
      const rows = await auditFor(school.id, 'academic_year', created.id);
      expect(rows.map((r) => r.action)).toEqual(['academic_year.created', 'academic_year.updated']);
      expect(rows[1]?.metadata).toEqual({
        changes: { endsOn: { from: '2027-03-31', to: '2027-04-30' } },
      });
    });

    it('activates and closes; same status is a no-op; closed is final', async () => {
      const school = await actAsNewSchool(a);
      const { id } = await year();
      const yearId = BigInt(id);
      await expect(a.years.activate(yearId)).resolves.toMatchObject({ status: 'active' });
      await expect(a.years.activate(yearId)).resolves.toMatchObject({ status: 'active' });
      // Several years may be active at once (rule 15).
      const other = await year();
      await expect(a.years.activate(BigInt(other.id))).resolves.toMatchObject({ status: 'active' });

      await expect(a.years.close(yearId)).resolves.toMatchObject({ status: 'closed' });
      await expect(a.years.close(yearId)).resolves.toMatchObject({ status: 'closed' });
      expect(await refusal(a.years.activate(yearId))).toMatchObject({
        status: 409,
        code: ErrorCode.ILLEGAL_STATUS_TRANSITION,
        details: { from: 'closed', to: 'active' },
      });
      expect(await refusal(a.years.update(yearId, { name: 'Renamed' }))).toMatchObject({
        status: 409,
        code: ErrorCode.ACADEMIC_YEAR_CLOSED,
      });
      const rows = await auditFor(school.id, 'academic_year', id);
      expect(rows.map((r) => [r.action, r.metadata])).toEqual([
        ['academic_year.created', expect.anything()],
        ['academic_year.activated', { from: 'planned', to: 'active' }],
        ['academic_year.closed', { from: 'active', to: 'closed' }],
      ]);
    });

    it('closes a planned year directly', async () => {
      await actAsNewSchool(a);
      const { id } = await year();
      await expect(a.years.close(BigInt(id))).resolves.toMatchObject({ status: 'closed' });
    });

    it('lists with the status filter and sort, paged', async () => {
      await actAsNewSchool(a);
      await year({ name: 'B', startsOn: '2025-04-01', endsOn: '2026-03-31' });
      const later = await year({ name: 'A', startsOn: '2026-04-01', endsOn: '2027-03-31' });
      await a.years.activate(BigInt(later.id));
      const all = await a.years.list({ page: 1, limit: 25 });
      expect(all.data.map((y) => y.name)).toEqual(['A', 'B']);
      expect(all.total).toBe(2);
      const byName = await a.years.list({ page: 1, limit: 1, sort: '-name' });
      expect(byName).toMatchObject({ total: 2, page: 1, limit: 1, data: [{ name: 'B' }] });
      const active = await a.years.list({ page: 1, limit: 25, status: 'active' });
      expect(active.data.map((y) => y.name)).toEqual(['A']);
    });

    it('gives up with 409 CONCURRENT_UPDATE when the row keeps changing', async () => {
      await actAsNewSchool(a);
      const { id } = await year();
      const lock = jest.spyOn(a.yearRepo, 'lockIfUnchanged').mockResolvedValue(false);
      expect(await refusal(a.years.update(BigInt(id), { name: 'Never' }))).toMatchObject({
        status: 409,
        code: ErrorCode.CONCURRENT_UPDATE,
      });
      expect(lock).toHaveBeenCalledTimes(3);
    });

    it('404s an id of another school', async () => {
      await actAsNewSchool(a);
      const { id } = await year();
      await actAsNewSchool(a);
      expect(await refusal(a.years.get(BigInt(id)))).toMatchObject({ status: 404 });
      expect(await refusal(a.years.close(BigInt(id)))).toMatchObject({ status: 404 });
    });

    // R44. Enrolments arrive in slice 6, which must make this pass inside
    // AcademicYearsService.assertNoActiveEnrolments.
    it.todo(
      'R44: close is refused with 409 ACADEMIC_YEAR_HAS_ACTIVE_ENROLMENTS while any enrolment in the year is active',
    );
  });

  describe('classes', () => {
    it('creates a class in an open year and audits it', async () => {
      const school = await actAsNewSchool(a);
      const y = await year({ name: 'Y1' });
      const created = await a.classes.create({
        academicYearId: y.id,
        name: 'Class 1',
        sortOrder: 3,
        attendanceMode: 'period',
      });
      expect(created).toMatchObject({
        academicYearId: y.id,
        academicYearName: 'Y1',
        name: 'Class 1',
        sortOrder: 3,
        attendanceMode: 'period',
        status: 'active',
      });
      const [row] = await auditFor(school.id, 'class', created.id);
      expect(row).toMatchObject({
        action: 'class.created',
        metadata: { academicYearId: y.id, name: 'Class 1' },
      });
    });

    it('refuses an unknown year, another school’s year (422) and a closed year (409)', async () => {
      await actAsNewSchool(a);
      const foreign = await year();
      await actAsNewSchool(a);
      for (const academicYearId of ['999999999999', foreign.id]) {
        expect(await refusal(klass(academicYearId))).toMatchObject({
          status: 422,
          details: { fields: [{ path: 'academicYearId', code: ErrorCode.REFERENCE_NOT_FOUND }] },
        });
      }
      const closed = await year();
      await a.years.close(BigInt(closed.id));
      expect(await refusal(klass(closed.id))).toMatchObject({
        status: 409,
        code: ErrorCode.ACADEMIC_YEAR_CLOSED,
      });
    });

    it('refuses a taken name in the same year (CLASS_NAME_TAKEN), not in another year', async () => {
      await actAsNewSchool(a);
      const y = await year();
      await klass(y.id, 'Nursery');
      expect(await refusal(klass(y.id, 'Nursery'))).toMatchObject({
        status: 409,
        code: ErrorCode.CLASS_NAME_TAKEN,
      });
      await expect(klass(undefined, 'Nursery')).resolves.toMatchObject({ name: 'Nursery' });
    });

    it('moves a class to another year only while it has no section, archived ones included', async () => {
      await actAsNewSchool(a);
      const c = await klass();
      const target = await year();
      const moved = await a.classes.update(BigInt(c.id), { academicYearId: target.id });
      expect(moved.academicYearId).toBe(target.id);

      const section = await a.sections.create(BigInt(c.id), { name: 'A' });
      await a.sections.archive(BigInt(section.id), {});
      const back = await year();
      expect(
        await refusal(a.classes.update(BigInt(c.id), { academicYearId: back.id })),
      ).toMatchObject({
        status: 409,
        code: ErrorCode.CLASS_YEAR_IMMUTABLE,
      });
      // The database's own line, behind the service check.
      const schoolId = a.ctx.schoolId;
      if (schoolId === undefined) throw new Error('no school');
      expect(
        await refusal(
          a.classRepo.update(schoolId, BigInt(c.id), { academicYearId: BigInt(back.id) }),
        ),
      ).toMatchObject({ status: 409, code: ErrorCode.CLASS_YEAR_IMMUTABLE });
    });

    it('refuses edits when its year or the target year is closed', async () => {
      await actAsNewSchool(a);
      const c = await klass();
      const closed = await year();
      await a.years.close(BigInt(closed.id));
      expect(
        await refusal(a.classes.update(BigInt(c.id), { academicYearId: closed.id })),
      ).toMatchObject({
        code: ErrorCode.ACADEMIC_YEAR_CLOSED,
      });
      await a.years.close(BigInt(c.academicYearId));
      expect(await refusal(a.classes.update(BigInt(c.id), { name: 'X' }))).toMatchObject({
        code: ErrorCode.ACADEMIC_YEAR_CLOSED,
      });
    });

    it('PATCH audits only real changes, attendanceMode included', async () => {
      const school = await actAsNewSchool(a);
      const c = await klass();
      await a.classes.update(BigInt(c.id), { name: c.name, attendanceMode: 'daily' });
      await a.classes.update(BigInt(c.id), { attendanceMode: 'period', sortOrder: 5 });
      const rows = await auditFor(school.id, 'class', c.id);
      expect(rows.map((r) => r.action)).toEqual(['class.created', 'class.updated']);
      expect(rows[1]?.metadata).toEqual({
        changes: {
          sortOrder: { from: 0, to: 5 },
          attendanceMode: { from: 'daily', to: 'period' },
        },
      });
    });

    it('archives once (no unarchive); an archived class is frozen', async () => {
      const school = await actAsNewSchool(a);
      const c = await klass();
      await expect(a.classes.archive(BigInt(c.id), { reason: 'Merged' })).resolves.toMatchObject({
        status: 'archived',
      });
      await expect(a.classes.archive(BigInt(c.id), {})).resolves.toMatchObject({
        status: 'archived',
      });
      const rows = await auditFor(school.id, 'class', c.id);
      expect(rows.map((r) => [r.action, r.reason])).toEqual([
        ['class.created', null],
        ['class.archived', 'Merged'],
      ]);
      expect(await refusal(a.classes.update(BigInt(c.id), { name: 'X' }))).toMatchObject({
        code: ErrorCode.CLASS_ARCHIVED,
      });
      expect(await refusal(a.sections.create(BigInt(c.id), { name: 'A' }))).toMatchObject({
        code: ErrorCode.CLASS_ARCHIVED,
      });
    });

    it('lists by year, status and q (LIKE wildcards literal), sorted by sortOrder', async () => {
      await actAsNewSchool(a);
      const y = await year();
      await a.classes.create({
        academicYearId: y.id,
        name: 'Two',
        sortOrder: 2,
        attendanceMode: 'daily',
      });
      await a.classes.create({
        academicYearId: y.id,
        name: 'One',
        sortOrder: 1,
        attendanceMode: 'daily',
      });
      await a.classes.create({
        academicYearId: y.id,
        name: '100% Club',
        sortOrder: 0,
        attendanceMode: 'daily',
      });
      await klass(undefined, 'Elsewhere');
      const list = await a.classes.list({ page: 1, limit: 25, academicYearId: y.id });
      expect(list.data.map((c) => c.name)).toEqual(['100% Club', 'One', 'Two']);
      expect(
        (await a.classes.list({ page: 1, limit: 25, q: '0%' })).data.map((c) => c.name),
      ).toEqual(['100% Club']);
      expect((await a.classes.list({ page: 1, limit: 25, q: '%' })).total).toBe(1);
      expect(
        (await a.classes.list({ page: 1, limit: 25, academicYearId: '999999999999' })).total,
      ).toBe(0);
    });

    // Slice 6 makes this pass inside ClassesService.assertNoActiveEnrolments.
    it.todo(
      'archive is refused with 409 CLASS_HAS_ACTIVE_ENROLMENTS while an active enrolment references the class',
    );
  });

  describe('copy-sections', () => {
    it('copies live sections, skips names the target has, and creates nothing on a repeat', async () => {
      const school = await actAsNewSchool(a);
      const from = await klass();
      const to = await klass();
      await a.sections.create(BigInt(from.id), { name: 'A', capacity: 30 });
      await a.sections.create(BigInt(from.id), { name: 'B' });
      const gone = await a.sections.create(BigInt(from.id), { name: 'Old' });
      await a.sections.archive(BigInt(gone.id), {});
      await a.sections.create(BigInt(to.id), { name: 'B' });

      const first = await a.classes.copySections(BigInt(to.id), { fromClassId: from.id });
      expect(first.created.map((s) => [s.name, s.capacity, s.classId])).toEqual([['A', 30, to.id]]);
      expect(first.skippedNames).toEqual(['B']);

      const again = await a.classes.copySections(BigInt(to.id), { fromClassId: from.id });
      expect(again).toEqual({ created: [], skippedNames: ['A', 'B'] });

      const rows = await auditFor(school.id, 'class', to.id);
      expect(
        rows.filter((r) => r.action === 'class.sections_copied').map((r) => r.metadata),
      ).toEqual([{ fromClassId: from.id, created: 1 }]);
    });

    it('refuses itself, an unknown or foreign source (422), and a closed or archived target (409)', async () => {
      await actAsNewSchool(a);
      const foreign = await klass();
      await actAsNewSchool(a);
      const target = await klass();
      expect(
        await refusal(a.classes.copySections(BigInt(target.id), { fromClassId: target.id })),
      ).toMatchObject({
        status: 422,
        details: { fields: [{ path: 'fromClassId', code: ErrorCode.INVALID_VALUE }] },
      });
      for (const fromClassId of ['999999999999', foreign.id]) {
        expect(
          await refusal(a.classes.copySections(BigInt(target.id), { fromClassId })),
        ).toMatchObject({
          status: 422,
          details: { fields: [{ path: 'fromClassId', code: ErrorCode.REFERENCE_NOT_FOUND }] },
        });
      }
      const source = await klass();
      await a.years.close(BigInt(target.academicYearId));
      expect(
        await refusal(a.classes.copySections(BigInt(target.id), { fromClassId: source.id })),
      ).toMatchObject({ code: ErrorCode.ACADEMIC_YEAR_CLOSED });
      const archived = await klass();
      await a.classes.archive(BigInt(archived.id), {});
      expect(
        await refusal(a.classes.copySections(BigInt(archived.id), { fromClassId: source.id })),
      ).toMatchObject({ code: ErrorCode.CLASS_ARCHIVED });
    });
  });

  describe('sections', () => {
    it('creates, edits (null clears capacity) and audits', async () => {
      const school = await actAsNewSchool(a);
      const c = await klass();
      const s = await a.sections.create(BigInt(c.id), { name: 'Rose', capacity: 40 });
      expect(s).toMatchObject({ classId: c.id, name: 'Rose', capacity: 40, archivedAt: null });
      const cleared = await a.sections.update(BigInt(s.id), { capacity: null });
      expect(cleared.capacity).toBeNull();
      const rows = await auditFor(school.id, 'section', s.id);
      expect(rows.map((r) => [r.action, r.metadata])).toEqual([
        ['section.created', { classId: c.id, name: 'Rose' }],
        ['section.updated', { changes: { capacity: { from: 40, to: null } } }],
      ]);
    });

    it('keeps live names unique per class; an archived name may be reused', async () => {
      await actAsNewSchool(a);
      const c = await klass();
      const first = await a.sections.create(BigInt(c.id), { name: 'A' });
      expect(await refusal(a.sections.create(BigInt(c.id), { name: 'A' }))).toMatchObject({
        status: 409,
        code: ErrorCode.SECTION_NAME_TAKEN,
      });
      await a.sections.archive(BigInt(first.id), { reason: 'Closed down' });
      await expect(a.sections.create(BigInt(c.id), { name: 'A' })).resolves.toMatchObject({
        name: 'A',
      });

      const live = await a.sections.listForClass(BigInt(c.id), { page: 1, limit: 25 });
      expect(live.total).toBe(1);
      const all = await a.sections.listForClass(BigInt(c.id), {
        page: 1,
        limit: 25,
        includeArchived: true,
      });
      expect(all.total).toBe(2);
      // The archived section is still readable by id.
      await expect(a.sections.get(BigInt(first.id))).resolves.toMatchObject({
        archivedAt: expect.any(Date),
      });
    });

    it('archives once; an archived section, or one in a closed year, is frozen', async () => {
      const school = await actAsNewSchool(a);
      const c = await klass();
      const s = await a.sections.create(BigInt(c.id), { name: 'A' });
      await a.sections.archive(BigInt(s.id), {});
      await a.sections.archive(BigInt(s.id), {});
      expect((await auditFor(school.id, 'section', s.id)).map((r) => r.action)).toEqual([
        'section.created',
        'section.archived',
      ]);
      expect(await refusal(a.sections.update(BigInt(s.id), { name: 'B' }))).toMatchObject({
        code: ErrorCode.SECTION_ARCHIVED,
      });
      const live = await a.sections.create(BigInt(c.id), { name: 'C' });
      await a.years.close(BigInt(c.academicYearId));
      expect(await refusal(a.sections.update(BigInt(live.id), { name: 'D' }))).toMatchObject({
        code: ErrorCode.ACADEMIC_YEAR_CLOSED,
      });
      expect(await refusal(a.sections.create(BigInt(c.id), { name: 'E' }))).toMatchObject({
        code: ErrorCode.ACADEMIC_YEAR_CLOSED,
      });
    });

    it('archive, like an edit, is refused in an archived class or a closed year', async () => {
      const school = await actAsNewSchool(a);
      const archivedClass = await klass();
      const inArchived = await a.sections.create(BigInt(archivedClass.id), { name: 'A' });
      await a.classes.archive(BigInt(archivedClass.id), {});
      expect(await refusal(a.sections.archive(BigInt(inArchived.id), {}))).toMatchObject({
        status: 409,
        code: ErrorCode.CLASS_ARCHIVED,
      });

      const closedClass = await klass();
      const inClosed = await a.sections.create(BigInt(closedClass.id), { name: 'A' });
      await a.years.close(BigInt(closedClass.academicYearId));
      expect(await refusal(a.sections.archive(BigInt(inClosed.id), {}))).toMatchObject({
        status: 409,
        code: ErrorCode.ACADEMIC_YEAR_CLOSED,
      });

      for (const id of [inArchived.id, inClosed.id]) {
        await expect(a.sections.get(BigInt(id))).resolves.toMatchObject({ archivedAt: null });
        expect((await auditFor(school.id, 'section', id)).map((r) => r.action)).toEqual([
          'section.created',
        ]);
      }
    });

    it('404s a class or section of another school', async () => {
      await actAsNewSchool(a);
      const c = await klass();
      const s = await a.sections.create(BigInt(c.id), { name: 'A' });
      await actAsNewSchool(a);
      expect(
        await refusal(a.sections.listForClass(BigInt(c.id), { page: 1, limit: 25 })),
      ).toMatchObject({
        status: 404,
      });
      expect(await refusal(a.sections.create(BigInt(c.id), { name: 'B' }))).toMatchObject({
        status: 404,
      });
      expect(await refusal(a.sections.update(BigInt(s.id), { name: 'B' }))).toMatchObject({
        status: 404,
      });
    });

    // Slices 4 and 6 make these pass inside SectionsService.assertSectionUnused.
    it.todo(
      'archive is refused with 409 SECTION_IN_USE while an active enrolment references the section',
    );
    it.todo(
      'archive is refused with 409 SECTION_IN_USE while a teacher assignment not yet ended references it',
    );
  });

  describe('subjects', () => {
    it('creates, edits (null clears code), archives once, and audits', async () => {
      const school = await actAsNewSchool(a);
      const s = await a.subjects.create({ name: 'Mathematics', code: 'MATH' });
      expect(s).toMatchObject({ name: 'Mathematics', code: 'MATH', archivedAt: null });
      await a.subjects.update(BigInt(s.id), { code: null });
      await a.subjects.archive(BigInt(s.id), { reason: 'Dropped' });
      await a.subjects.archive(BigInt(s.id), {});
      expect(await refusal(a.subjects.update(BigInt(s.id), { name: 'Maths' }))).toMatchObject({
        status: 409,
        code: ErrorCode.SUBJECT_ARCHIVED,
      });
      const rows = await auditFor(school.id, 'subject', s.id);
      expect(rows.map((r) => [r.action, r.metadata])).toEqual([
        ['subject.created', { name: 'Mathematics', code: 'MATH' }],
        ['subject.updated', { changes: { code: { from: 'MATH', to: null } } }],
        ['subject.archived', {}],
      ]);
    });

    it('keeps live names and codes unique; archived ones may be reused', async () => {
      await actAsNewSchool(a);
      const first = await a.subjects.create({ name: 'English', code: 'ENG' });
      expect(await refusal(a.subjects.create({ name: 'English' }))).toMatchObject({
        code: ErrorCode.SUBJECT_NAME_TAKEN,
      });
      expect(await refusal(a.subjects.create({ name: 'English II', code: 'ENG' }))).toMatchObject({
        code: ErrorCode.SUBJECT_CODE_TAKEN,
      });
      // Several subjects may have no code.
      await a.subjects.create({ name: 'Art' });
      await a.subjects.create({ name: 'Music', code: null });
      await a.subjects.archive(BigInt(first.id), {});
      await expect(a.subjects.create({ name: 'English', code: 'ENG' })).resolves.toMatchObject({
        code: 'ENG',
      });
    });

    it('lists live by default, with q over name or code prefix', async () => {
      await actAsNewSchool(a);
      await a.subjects.create({ name: 'Physics', code: 'PHY' });
      await a.subjects.create({ name: 'Urdu', code: 'URD' });
      const old = await a.subjects.create({ name: 'Physical Education' });
      await a.subjects.archive(BigInt(old.id), {});
      expect((await a.subjects.list({ page: 1, limit: 25 })).data.map((s) => s.name)).toEqual([
        'Physics',
        'Urdu',
      ]);
      expect(
        (await a.subjects.list({ page: 1, limit: 25, q: 'phys', includeArchived: true })).total,
      ).toBe(2);
      expect(
        (await a.subjects.list({ page: 1, limit: 25, q: 'ur' })).data.map((s) => s.code),
      ).toEqual(['URD']);
      expect((await a.subjects.list({ page: 1, limit: 25, sort: '-code' })).data[0]?.code).toBe(
        'URD',
      );
    });
  });

  it('writes nothing when the audit row cannot be written (one transaction)', async () => {
    const school = await actAsNewSchool(a);
    // An identity number in the reason violates audit_log_reason_no_id_check (the DTO normally
    // refuses it first), so the archive must roll back with it.
    const s = await a.subjects.create({ name: `Rollback ${tag()}` });
    await expect(
      a.subjects.archive(BigInt(s.id), { reason: '3520212345671' }),
    ).rejects.toBeDefined();
    const row = await testDb().subject.findFirst({
      where: { schoolId: school.id, id: BigInt(s.id) },
    });
    expect(row?.deletedAt).toBeNull();
  });
});
