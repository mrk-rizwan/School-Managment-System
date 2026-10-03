// Slice 5 (contracts/slice-5.md) at the service layer, over the real database: CNIC storage and
// uniqueness, merge resolution on lookup (R31), shared phones (R32), R27, PATCH rules, issue-login
// (R21, R22, R77, R12/R14 target rules) and tenant isolation (control 4).
import { Test } from '@nestjs/testing';
import { Capability } from '@asms/shared';
import { randomBytes } from 'node:crypto';
import { CryptoModule } from '../../src/common/crypto/crypto.module';
import { FieldEncryption } from '../../src/common/crypto/field-encryption';
import { PasswordHasher } from '../../src/common/crypto/password';
import { ApiException } from '../../src/common/errors/api-exception';
import { SchoolContext, type Actor } from '../../src/common/school-context';
import { EnvModule } from '../../src/config/env';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { GuardianLoginService } from '../../src/modules/people/guardians/guardian-login.service';
import type { CreateGuardianDto } from '../../src/modules/people/guardians/guardians.dto';
import { GuardiansService } from '../../src/modules/people/guardians/guardians.service';
import { AuditLogRepository } from '../../src/repositories/audit-log.repository';
import { EnrolmentRepository } from '../../src/repositories/enrolment.repository';
import { GuardianLoginRepository } from '../../src/repositories/guardian-login.repository';
import { GuardianRepository } from '../../src/repositories/guardian.repository';
import { StudentGuardianRepository } from '../../src/repositories/student-guardian.repository';
import { UserRepository } from '../../src/repositories/user.repository';
import { AccessModule } from '../../src/modules/access/access.module';
import { RequestContextService } from '../../src/tenancy/request-context';
import type { SchoolId } from '../../src/tenancy/school-id';
import type { Scope } from '../../src/tenancy/scope';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { expectIsolated } from '../support/isolation';
import {
  createSchoolUser,
  randomIdentityDigits,
  testIdentityHash,
  type SchoolUserOptions,
} from '../support/school-session';
import {
  closeTestDb,
  createSchool,
  createTwoSchools,
  testDb,
  type TestSchool,
} from '../support/schools';
import { createClassWithSection, createStudent, enrol, linkGuardian } from '../support/students';

const PAGE = { page: 1, limit: 50 } as const;

/** A random Pakistani mobile in E.164. */
const randomPhone = (): string =>
  `+923${BigInt(`0x${randomBytes(5).toString('hex')}`)
    .toString()
    .padStart(9, '0')
    .slice(0, 9)}`;

const caught = (promise: Promise<unknown>): Promise<ApiException> =>
  promise.then(
    () => {
      throw new Error('expected an ApiException');
    },
    (e: unknown) => {
      if (!(e instanceof ApiException)) throw e;
      return e;
    },
  );

describe('guardians (service)', () => {
  let service: GuardiansService;
  let logins: GuardianLoginService;
  let repo: GuardianRepository;
  let encryption: FieldEncryption;
  let passwords: PasswordHasher;
  /** A school-wide scope, from a principal's guardian.manage (the guardian routes' scope). */
  let wholeSchool: Scope;
  let close: () => Promise<void>;
  const db = testDb();
  /** What session resolution would put in the request context, set per call. */
  const ctx: { schoolId: SchoolId | undefined; userId: bigint | undefined } = {
    schoolId: undefined,
    userId: undefined,
  };

  /** The services as `actor`; a bare school id acts as a reader of that school. */
  const actAs = (actor: Actor | SchoolId): void => {
    ctx.schoolId = typeof actor === 'bigint' ? actor : actor.schoolId;
    ctx.userId = typeof actor === 'bigint' ? 0n : actor.userId;
  };
  const by = (actor: Actor | SchoolId): GuardiansService => {
    actAs(actor);
    return service;
  };
  /**
   * Issue-login as `actor`, first giving the guardian (when it is the actor's school's) a live
   * link with can_login, which slice 6 made a precondition (GUARDIAN_NO_LOGIN_LINK). The tests of
   * that precondition call `logins` directly.
   */
  const loginsBy = (actor: Actor): Pick<GuardianLoginService, 'issueLogin'> => ({
    issueLogin: async (guardianId: bigint) => {
      await allowLogin(actor.schoolId, guardianId);
      actAs(actor);
      return logins.issueLogin(guardianId, {});
    },
  });

  /** A student linked to the guardian with can_login, unless one is already live. */
  async function allowLogin(schoolId: SchoolId, guardianId: bigint): Promise<void> {
    if (!(await db.guardian.findFirst({ where: { schoolId, id: guardianId } }))) return;
    const live = await db.studentGuardian.findFirst({
      where: { schoolId, guardianId, canLogin: true, endedAt: null },
    });
    if (live) return;
    const school = { id: schoolId, shortCode: '' };
    const student = await createStudent(db, school);
    await linkGuardian(db, school, student, { id: guardianId }, { canLogin: true });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule, AccessModule, CryptoModule],
      providers: [
        SchoolContext,
        GuardiansService,
        GuardianLoginService,
        GuardianRepository,
        GuardianLoginRepository,
        UserRepository,
        AuditLogRepository,
        StudentGuardianRepository,
        EnrolmentRepository,
      ],
    })
      .overrideProvider(RequestContextService)
      .useValue(ctx)
      .compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    service = moduleRef.get(GuardiansService);
    logins = moduleRef.get(GuardianLoginService);
    repo = moduleRef.get(GuardianRepository);
    encryption = moduleRef.get(FieldEncryption);
    passwords = moduleRef.get(PasswordHasher);

    const school = await createSchool();
    const principal = await createSchoolUser(db, school, { systemRole: 'principal' });
    const permissions = moduleRef.get(PermissionsService);
    const access = await permissions.load(school.id, principal.userId);
    const scope = access && (await permissions.can(school.id, access, Capability.GUARDIAN_MANAGE));
    if (!scope || scope.kind !== 'all') throw new Error('expected a school-wide scope');
    wholeSchool = scope;
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  /** An office-staff user (guardian.manage, user.account.manage) acting in `school`. */
  async function staffActor(
    school: TestSchool,
    options: Partial<SchoolUserOptions> = {},
  ): Promise<Actor & { cnic: string }> {
    const user = await createSchoolUser(db, school, { systemRole: 'office_staff', ...options });
    return { schoolId: school.id, userId: user.userId, cnic: user.cnic };
  }

  const guardianInput = (overrides: Partial<CreateGuardianDto> = {}): CreateGuardianDto => ({
    fullName: 'Ahmed Khan',
    cnic: randomIdentityDigits(),
    phone: randomPhone(),
    contactCapability: 'whatsapp',
    ...overrides,
  });

  /** Marks `id` merged into `into`, as slice 6's merge will. */
  async function merge(schoolId: SchoolId, id: string, into: string): Promise<void> {
    await db.guardian.update({
      where: { schoolId_id: { schoolId, id: BigInt(id) } },
      data: { status: 'merged', mergedIntoId: BigInt(into) },
    });
  }

  const auditRows = (schoolId: SchoolId, action: string) =>
    db.auditLog.findMany({ where: { schoolId, action }, orderBy: { id: 'asc' } });

  // ------------------------------------------------------------------------------- isolation

  it('guardians: a row written as school A is invisible to and unwritable by school B (control 4)', async () => {
    const schools = await createTwoSchools();
    const actorA = await staffActor(schools.a);
    const actorB = await staffActor(schools.b);
    const actorFor = (schoolId: SchoolId): Actor => (schoolId === schools.a.id ? actorA : actorB);
    await expectIsolated(schools, {
      create: async (schoolId) => BigInt((await by(actorFor(schoolId)).create(guardianInput())).id),
      read: (schoolId, id) => repo.findById(schoolId, id),
      list: async (schoolId) =>
        (await repo.list(schoolId, { sort: 'fullName', skip: 0, take: 50 })).rows,
      write: async (schoolId, id) => {
        await by(actorFor(schoolId)).update(id, { fullName: 'Intruder' });
        return 1;
      },
      snapshot: (row) => (row as { fullName: string }).fullName,
    });
  });

  it('control 4: school B cannot find, read, patch or issue a login for school A’s guardian', async () => {
    const { a, b } = await createTwoSchools();
    const actorA = await staffActor(a);
    const actorB = await staffActor(b);
    const input = guardianInput();
    const created = await by(actorA).create(input);
    const id = BigInt(created.id);

    expect((await by(b.id).lookup(wholeSchool, { cnic: input.cnic ?? '' })).data).toEqual([]);
    expect((await by(b.id).lookup(wholeSchool, { phone: input.phone ?? '' })).data).toEqual([]);
    expect(await caught(by(b.id).get(id))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await caught(by(b.id).students(wholeSchool, id, PAGE))).toMatchObject({ status: 404 });
    expect(await caught(by(actorB).update(id, { fullName: 'X Y' }))).toMatchObject({
      status: 404,
    });
    expect(await caught(loginsBy(actorB).issueLogin(id, {}))).toMatchObject({ status: 404 });
    expect(await db.user.count({ where: { schoolId: b.id } })).toBe(1);
  });

  it('the same CNIC in two schools is two guardians (one per tenant)', async () => {
    const { a, b } = await createTwoSchools();
    const cnic = randomIdentityDigits();
    await by(await staffActor(a)).create(guardianInput({ cnic }));
    await expect(by(await staffActor(b)).create(guardianInput({ cnic }))).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------------- create

  it('stores the CNIC encrypted with its hash, returns it masked, audits no identity data', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const input = guardianInput({ email: 'parent@example.com', address: 'House 1, Lahore' });
    const created = await by(actor).create(input);
    const cnic = input.cnic ?? '';

    expect(created).toMatchObject({
      fullName: 'Ahmed Khan',
      cnicMasked: `${cnic.slice(0, 5)}-*****-${cnic.slice(12)}`,
      hasCnic: true,
      phone: input.phone,
      hasPhone: true,
      contactCapability: 'whatsapp',
      status: 'active',
      mergedIntoId: null,
      userId: null,
      email: 'parent@example.com',
      address: 'House 1, Lahore',
    });
    expect(JSON.stringify(created)).not.toContain(cnic);

    const row = await db.guardian.findFirst({
      where: { schoolId: school.id, id: BigInt(created.id) },
    });
    expect(row?.cnic).toMatch(/^v1:/);
    expect(row?.cnic).not.toContain(cnic);
    expect(row?.cnicHash).toBe(testIdentityHash(cnic));
    expect(encryption.decrypt(row?.cnic ?? '', `${school.id}|guardians|cnic`)).toBe(cnic);

    const [audit] = await auditRows(school.id, 'guardian.created');
    expect(audit).toMatchObject({
      actorUserId: actor.userId,
      subjectType: 'guardian',
      subjectId: BigInt(created.id),
      metadata: { hasCnic: true, hasPhone: true, contactCapability: 'whatsapp' },
    });
  });

  it('R27: a guardian with neither CNIC nor phone is recorded, but gets no login', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const created = await by(actor).create({
      fullName: 'Keypad Parent',
      cnic: null,
      phone: null,
      contactCapability: 'keypad',
    });
    expect(created).toMatchObject({
      cnicMasked: null,
      hasCnic: false,
      phone: null,
      hasPhone: false,
    });
    expect(await caught(loginsBy(actor).issueLogin(BigInt(created.id), {}))).toMatchObject({
      status: 409,
      code: 'GUARDIAN_CNIC_MISSING',
    });
  });

  it('refuses a second guardian with the same CNIC, pointing at the existing one', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const cnic = randomIdentityDigits();
    const first = await by(actor).create(guardianInput({ cnic }));
    const error = await caught(by(actor).create(guardianInput({ cnic, fullName: 'Other' })));
    expect(error).toMatchObject({
      status: 409,
      code: 'GUARDIAN_CNIC_EXISTS',
      details: { guardianId: first.id },
    });
    expect(await db.guardian.count({ where: { schoolId: school.id } })).toBe(1);
  });

  it('a CNIC held by a merged guardian points at the survivor', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const cnic = randomIdentityDigits();
    const merged = await by(actor).create(guardianInput({ cnic }));
    const survivor = await by(actor).create(guardianInput({ cnic: null }));
    await merge(school.id, merged.id, survivor.id);
    expect(await caught(by(actor).create(guardianInput({ cnic })))).toMatchObject({
      code: 'GUARDIAN_CNIC_EXISTS',
      details: { guardianId: survivor.id },
    });
  });

  it('two racing creates of one CNIC: one row, the loser gets the same 409 pointer', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const cnic = randomIdentityDigits();
    const results = await Promise.allSettled([
      by(actor).create(guardianInput({ cnic, fullName: 'Racer One' })),
      by(actor).create(guardianInput({ cnic, fullName: 'Racer Two' })),
    ]);
    const won = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const lost = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(ApiException);
    expect(lost[0]).toMatchObject({
      status: 409,
      code: 'GUARDIAN_CNIC_EXISTS',
      details: { guardianId: won[0]?.id },
    });
    expect(await db.guardian.count({ where: { schoolId: school.id } })).toBe(1);
  });

  // ---------------------------------------------------------------------------------- lookup

  it('lookup by CNIC finds the guardian; a miss is an empty list; the CNIC is never echoed', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const input = guardianInput();
    const created = await by(actor).create(input);
    const result = await by(school.id).lookup(wholeSchool, { cnic: input.cnic ?? '' });
    expect(result).toEqual({
      data: [
        {
          guardian: expect.objectContaining({ id: created.id }),
          resolvedFromId: null,
          students: [],
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(input.cnic);
    expect(await by(school.id).lookup(wholeSchool, { cnic: randomIdentityDigits() })).toEqual({
      data: [],
      truncated: false,
    });
  });

  it('lookup needs exactly one of cnic and phone (422 on the body root)', async () => {
    const school = await createSchool();
    for (const body of [{}, { cnic: randomIdentityDigits(), phone: randomPhone() }]) {
      expect(await caught(by(school.id).lookup(wholeSchool, body))).toMatchObject({
        status: 422,
        code: 'VALIDATION_FAILED',
        details: { fields: [{ path: '', code: 'INVALID_VALUE' }] },
      });
    }
  });

  it('R32: a phone shared by several guardians returns all of them, ordered by name', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const phone = randomPhone();
    const zara = await by(actor).create(
      guardianInput({ phone, fullName: 'Zara Bibi', cnic: null }),
    );
    const ali = await by(actor).create(guardianInput({ phone, fullName: 'Ali Raza' }));
    await by(actor).create(guardianInput({ fullName: 'Other Phone' }));
    const result = await by(school.id).lookup(wholeSchool, { phone });
    expect(result.data.map((hit) => hit.guardian.id)).toEqual([ali.id, zara.id]);
    expect(result.truncated).toBe(false);
  });

  it('R31: a hit on a merged guardian resolves to the survivor, noting the merged id', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const input = guardianInput();
    const merged = await by(actor).create(input);
    const survivor = await by(actor).create(guardianInput({ cnic: null, phone: randomPhone() }));
    await merge(school.id, merged.id, survivor.id);

    const result = await by(school.id).lookup(wholeSchool, { cnic: input.cnic ?? '' });
    expect(result.data).toEqual([
      {
        guardian: expect.objectContaining({ id: survivor.id, status: 'active' }),
        resolvedFromId: merged.id,
        students: [],
      },
    ]);
  });

  it('R31: phone hits on a merged guardian and its survivor are one result, the direct hit', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const phone = randomPhone();
    const merged = await by(actor).create(guardianInput({ phone, fullName: 'Aaa First' }));
    const survivor = await by(actor).create(guardianInput({ phone, fullName: 'Bbb Second' }));
    await merge(school.id, merged.id, survivor.id);
    const result = await by(school.id).lookup(wholeSchool, { phone });
    expect(result.data).toEqual([
      expect.objectContaining({
        guardian: expect.objectContaining({ id: survivor.id }),
        resolvedFromId: null,
      }),
    ]);
  });

  it('R31: follows a chain of five merges; a sixth hop is a data fault (500)', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const phones = Array.from({ length: 7 }, randomPhone);
    const chain = [];
    for (const phone of phones)
      chain.push(await by(actor).create(guardianInput({ phone, cnic: null })));
    for (let i = 0; i < chain.length - 1; i++) {
      await merge(school.id, chain[i]?.id ?? '', chain[i + 1]?.id ?? '');
    }
    // phones[1] is five hops from the end of the chain; phones[0] is six.
    const five = await by(school.id).lookup(wholeSchool, { phone: phones[1] ?? '' });
    expect(five.data[0]).toMatchObject({
      guardian: { id: chain[6]?.id },
      resolvedFromId: chain[1]?.id,
    });
    expect(await caught(by(school.id).lookup(wholeSchool, { phone: phones[0] ?? '' }))).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('lookup returns at most 20 and reports truncation', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const phone = randomPhone();
    for (let i = 0; i < 21; i++) {
      await by(actor).create(guardianInput({ phone, cnic: null, fullName: `Family ${i}` }));
    }
    const result = await by(school.id).lookup(wholeSchool, { phone });
    expect(result.data).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  // ------------------------------------------------------------------------------------ list

  it('lists with the CNIC, phone and login flags, name and phone search, and sort', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const full = await by(actor).create(
      guardianInput({ fullName: 'Bilal Full', phone: '+923001234567' }),
    );
    const noCnic = await by(actor).create(guardianInput({ fullName: 'Asma NoCnic', cnic: null }));
    const noPhone = await by(actor).create(
      guardianInput({ fullName: 'Chand NoPhone', phone: null, contactCapability: 'keypad' }),
    );
    await loginsBy(actor).issueLogin(BigInt(full.id), {});

    const ids = async (query: Parameters<GuardiansService['list']>[0]) =>
      (await by(school.id).list(query)).data.map((g) => g.id);

    expect(await ids({ ...PAGE })).toEqual([noCnic.id, full.id, noPhone.id]);
    expect(await ids({ ...PAGE, sort: '-fullName' })).toEqual([noPhone.id, full.id, noCnic.id]);
    expect(await ids({ ...PAGE, hasCnic: false })).toEqual([noCnic.id]);
    expect(await ids({ ...PAGE, hasPhone: false })).toEqual([noPhone.id]);
    expect(await ids({ ...PAGE, hasLogin: true })).toEqual([full.id]);
    expect(await ids({ ...PAGE, hasLogin: false })).toEqual([noCnic.id, noPhone.id]);
    expect(await ids({ ...PAGE, contactCapability: 'keypad' })).toEqual([noPhone.id]);
    expect(await ids({ ...PAGE, q: 'nocnic' })).toEqual([noCnic.id]);
    expect(await ids({ ...PAGE, q: '1234567' })).toEqual([full.id]);
    expect(await ids({ ...PAGE, q: '0300 1234' })).toEqual([full.id]);
    expect(await ids({ ...PAGE, q: '%' })).toEqual([]);

    const page = await by(school.id).list({ page: 2, limit: 1 });
    expect(page).toMatchObject({
      page: 2,
      limit: 1,
      total: 3,
      data: [{ id: full.id, userId: expect.any(String) }],
    });
  });

  it('students: an empty page for an existing guardian until slice 6', async () => {
    const school = await createSchool();
    const created = await by(await staffActor(school)).create(guardianInput());
    expect(await by(school.id).students(wholeSchool, BigInt(created.id), PAGE)).toEqual({
      data: [],
      page: 1,
      limit: 50,
      total: 0,
    });
  });

  // ----------------------------------------------------------------------------------- patch

  it('PATCH edits, clears and audits changes without identity or contact values', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const created = await by(actor).create(guardianInput({ email: 'old@example.com' }));
    const newCnic = randomIdentityDigits();
    const updated = await by(actor).update(BigInt(created.id), {
      fullName: 'Ahmed Raza Khan',
      cnic: newCnic,
      phone: null,
      email: null,
      contactCapability: 'keypad',
    });
    expect(updated).toMatchObject({
      fullName: 'Ahmed Raza Khan',
      cnicMasked: `${newCnic.slice(0, 5)}-*****-${newCnic.slice(12)}`,
      phone: null,
      hasPhone: false,
      email: null,
      contactCapability: 'keypad',
    });
    const [audit] = await auditRows(school.id, 'guardian.updated');
    expect(audit?.metadata).toEqual({
      changes: {
        fullName: { from: 'Ahmed Khan', to: 'Ahmed Raza Khan' },
        contactCapability: { from: 'whatsapp', to: 'keypad' },
        cnic: { changed: true },
        phone: { changed: true },
        email: { changed: true },
      },
    });
    expect(JSON.stringify(audit?.metadata)).not.toMatch(/[0-9]{13}|example\.com/);
  });

  it('PATCH with nothing actually changing writes nothing and audits nothing', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const input = guardianInput();
    const created = await by(actor).create(input);
    const same = await by(actor).update(BigInt(created.id), {
      fullName: input.fullName,
      cnic: input.cnic ?? null,
      phone: input.phone ?? null,
    });
    expect(same.updatedAt).toEqual(created.updatedAt);
    expect(await auditRows(school.id, 'guardian.updated')).toEqual([]);
  });

  it('PATCH refuses a CNIC already on another guardian, a merged guardian, and a CNIC with a login', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const other = guardianInput();
    const otherRow = await by(actor).create(other);
    const target = await by(actor).create(guardianInput());
    const id = BigInt(target.id);

    expect(await caught(by(actor).update(id, { cnic: other.cnic ?? null }))).toMatchObject({
      status: 409,
      code: 'GUARDIAN_CNIC_EXISTS',
      details: { guardianId: otherRow.id },
    });

    await loginsBy(actor).issueLogin(id, {});
    for (const cnic of [randomIdentityDigits(), null]) {
      expect(await caught(by(actor).update(id, { cnic }))).toMatchObject({
        status: 409,
        code: 'GUARDIAN_CNIC_LOCKED',
      });
    }
    // Other fields stay editable with a login.
    await expect(by(actor).update(id, { fullName: 'Still Editable' })).resolves.toMatchObject({
      fullName: 'Still Editable',
    });

    await merge(school.id, otherRow.id, target.id);
    expect(await caught(by(actor).update(BigInt(otherRow.id), { fullName: 'X Y' }))).toMatchObject({
      status: 409,
      code: 'GUARDIAN_MERGED',
    });
  });

  it('PATCH gives up with 409 CONCURRENT_UPDATE when the row keeps changing', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const created = await by(actor).create(guardianInput());
    const lock = jest.spyOn(repo, 'lockIfUnchanged').mockResolvedValue(false);
    expect(await caught(by(actor).update(BigInt(created.id), { fullName: 'Never' }))).toMatchObject(
      {
        status: 409,
        code: 'CONCURRENT_UPDATE',
      },
    );
    expect(lock).toHaveBeenCalledTimes(3);
    expect((await repo.findById(school.id, BigInt(created.id)))?.fullName).toBe('Ahmed Khan');
  });

  it('R30: PATCH clearing the phone of a primary contact on a live link is 409 GUARDIAN_IS_PRIMARY_CONTACT', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const primary = await by(actor).create(guardianInput());
    const secondary = await by(actor).create(guardianInput());
    const student = await createStudent(db, school);
    const link = await linkGuardian(db, school, student, { id: BigInt(primary.id) });
    await linkGuardian(
      db,
      school,
      student,
      { id: BigInt(secondary.id) },
      { isPrimaryContact: false },
    );

    expect(await caught(by(actor).update(BigInt(primary.id), { phone: null }))).toMatchObject({
      status: 409,
      code: 'GUARDIAN_IS_PRIMARY_CONTACT',
    });
    expect((await by(actor).get(BigInt(primary.id))).phone).toBe(primary.phone);
    // Not primary: the phone may go. Ended links do not count either.
    await expect(by(actor).update(BigInt(secondary.id), { phone: null })).resolves.toMatchObject({
      phone: null,
    });
    await db.studentGuardian.update({
      where: { schoolId_id: { schoolId: school.id, id: link.id } },
      data: { endedAt: new Date(), isPrimaryContact: false },
    });
    await expect(by(actor).update(BigInt(primary.id), { phone: null })).resolves.toMatchObject({
      phone: null,
    });
  });

  it('GET :id/students lists live links (all with includeEnded) with class and section', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const guardian = await by(actor).create(guardianInput());
    const gid = { id: BigInt(guardian.id) };
    const { section } = await createClassWithSection(db, school);
    const zara = await createStudent(db, school, { fullName: 'Zara Enrolled' });
    const ali = await createStudent(db, school, { fullName: 'Ali Ended' });
    await enrol(db, school, zara, section);
    const live = await linkGuardian(db, school, zara, gid, {
      relationship: 'mother',
      canLogin: true,
    });
    const ended = await linkGuardian(db, school, ali, gid, { endedAt: new Date() });

    const page = await by(school.id).students(wholeSchool, gid.id, PAGE);
    expect(page.total).toBe(1);
    expect(page.data).toEqual([
      {
        linkId: live.id.toString(),
        studentId: zara.id.toString(),
        studentFullName: 'Zara Enrolled',
        admissionNo: zara.admissionNo,
        relationship: 'mother',
        isPrimaryContact: true,
        isFeePayer: true,
        canLogin: true,
        className: expect.any(String),
        sectionName: expect.any(String),
        linkEndedAt: null,
      },
    ]);
    const all = await by(school.id).students(wholeSchool, gid.id, { ...PAGE, includeEnded: true });
    expect(all.data.map((r) => r.linkId)).toEqual([ended.id.toString(), live.id.toString()]);
    expect(all.data[0]).toMatchObject({ className: null, sectionName: null });
  });

  it('lookup fills students with the survivor’s live links', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const input = guardianInput();
    const guardian = await by(actor).create(input);
    const student = await createStudent(db, school, { fullName: 'Linked Child' });
    await linkGuardian(
      db,
      school,
      student,
      { id: BigInt(guardian.id) },
      { relationship: 'father' },
    );
    const other = await createStudent(db, school);
    await linkGuardian(db, school, other, { id: BigInt(guardian.id) }, { endedAt: new Date() });

    const result = await by(school.id).lookup(wholeSchool, { cnic: input.cnic ?? '' });
    expect(result.data[0]?.students).toEqual([
      {
        studentId: student.id.toString(),
        fullName: 'Linked Child',
        className: null,
        relationship: 'father',
      },
    ]);
  });

  // ----------------------------------------------------------------------------- issue-login

  it('issues a login: username = CNIC hash, default password = the digits, linked, audited', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const input = guardianInput({ email: 'contact@example.com' });
    const created = await by(actor).create(input);
    const user = await loginsBy(actor).issueLogin(BigInt(created.id), {});

    expect(user).toMatchObject({
      staffId: null,
      guardianId: created.id,
      studentId: null,
      fullName: 'Ahmed Khan',
      systemRoles: [],
      status: 'active',
      // The guardian's contact email is not the login's reset address (contract §3.7).
      emailMasked: null,
      hasEmail: false,
      hasVerifiedEmail: false,
      passwordIsDefault: true,
      lastLoginAt: null,
    });
    const row = await db.user.findFirst({ where: { schoolId: school.id, id: BigInt(user.id) } });
    expect(row?.usernameHash).toBe(testIdentityHash(input.cnic ?? ''));
    expect(await passwords.verify(row?.passwordHash ?? '', input.cnic ?? '')).toBe(true);
    expect((await by(school.id).get(BigInt(created.id))).userId).toBe(user.id);

    const [audit] = await auditRows(school.id, 'user.login_issued');
    expect(audit).toMatchObject({
      actorUserId: actor.userId,
      subjectType: 'user',
      subjectId: BigInt(user.id),
      metadata: { capacity: 'guardian', linkedExistingUser: false },
    });

    expect(await caught(loginsBy(actor).issueLogin(BigInt(created.id), {}))).toMatchObject({
      status: 409,
      code: 'LOGIN_ALREADY_EXISTS',
    });
  });

  it('issue-login refuses a merged guardian', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const merged = await by(actor).create(guardianInput());
    const survivor = await by(actor).create(guardianInput());
    await merge(school.id, merged.id, survivor.id);
    expect(await caught(loginsBy(actor).issueLogin(BigInt(merged.id), {}))).toMatchObject({
      status: 409,
      code: 'GUARDIAN_MERGED',
    });
  });

  it('R22: a teacher who is also a parent keeps one login, linked to the guardian', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const teacher = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const guardian = await by(actor).create(guardianInput({ cnic: teacher.cnic }));
    // The office (no role.manage) may act on a teacher only if the teacher's set is within its own.
    const principal = await staffActor(school, { systemRole: 'principal' });
    const user = await loginsBy(principal).issueLogin(BigInt(guardian.id), {});
    expect(user).toMatchObject({
      id: teacher.userId.toString(),
      staffId: teacher.staffId.toString(),
      guardianId: guardian.id,
      systemRoles: ['teacher'],
    });
    expect(
      await db.user.count({ where: { schoolId: school.id, usernameHash: teacher.usernameHash } }),
    ).toBe(1);
    const [audit] = await auditRows(school.id, 'user.login_issued');
    expect(audit?.metadata).toEqual({ capacity: 'guardian', linkedExistingUser: true });
  });

  it('R12/R14: linking onto a principal or a wider staff login needs role.manage', async () => {
    const school = await createSchool();
    const office = await staffActor(school);
    const principalTarget = await createSchoolUser(db, school, { systemRole: 'principal' });
    const teacherTarget = await createSchoolUser(db, school, { systemRole: 'teacher' });
    const officeTarget = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const forPerson = async (cnic: string) =>
      BigInt((await by(office).create(guardianInput({ cnic }))).id);

    expect(
      await caught(loginsBy(office).issueLogin(await forPerson(principalTarget.cnic), {})),
    ).toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
      details: { reason: 'target_is_principal' },
    });
    // A teacher holds attendance and marks keys the office does not.
    expect(
      await caught(loginsBy(office).issueLogin(await forPerson(teacherTarget.cnic), {})),
    ).toMatchObject({
      status: 403,
      details: { reason: 'target_exceeds_actor' },
    });
    // Same set as the actor: allowed.
    await expect(
      loginsBy(office).issueLogin(await forPerson(officeTarget.cnic), {}),
    ).resolves.toMatchObject({
      id: officeTarget.userId.toString(),
    });
  });

  it('issue-login refuses linking onto a disabled login and onto the caller’s own', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const disabled = await createSchoolUser(db, school, {
      systemRole: 'office_staff',
      userStatus: 'disabled',
    });
    const forDisabled = await by(actor).create(guardianInput({ cnic: disabled.cnic }));
    expect(await caught(loginsBy(actor).issueLogin(BigInt(forDisabled.id), {}))).toMatchObject({
      status: 409,
      code: 'USER_DISABLED',
    });
    const forSelf = await by(actor).create(guardianInput({ cnic: actor.cnic }));
    expect(await caught(loginsBy(actor).issueLogin(BigInt(forSelf.id), {}))).toMatchObject({
      status: 409,
      code: 'SELF_ACTION_FORBIDDEN',
    });
    expect(await db.user.count({ where: { schoolId: school.id, guardianId: { not: null } } })).toBe(
      0,
    );
  });

  it('R77: two racing issue-logins create one user; the loser gets LOGIN_ALREADY_EXISTS', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const created = await by(actor).create(guardianInput());
    const results = await Promise.allSettled([
      loginsBy(actor).issueLogin(BigInt(created.id), {}),
      loginsBy(actor).issueLogin(BigInt(created.id), {}),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [lost] = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(lost).toMatchObject({ status: 409, code: 'LOGIN_ALREADY_EXISTS' });
    expect(
      await db.user.count({ where: { schoolId: school.id, guardianId: BigInt(created.id) } }),
    ).toBe(1);
  });

  it('R77: a username taken between the read and the insert is retried on the link path', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const officeTarget = await createSchoolUser(db, school, { systemRole: 'office_staff' });
    const created = await by(actor).create(guardianInput({ cnic: officeTarget.cnic }));
    const loginRepo = jest.spyOn(UserRepository.prototype, 'findCredentialsByUsernameHash');
    // First pass: the existing user is not seen, so the insert hits the username unique key.
    loginRepo.mockResolvedValueOnce(null);
    const user = await loginsBy(actor).issueLogin(BigInt(created.id), {});
    expect(user).toMatchObject({ id: officeTarget.userId.toString(), guardianId: created.id });
    expect(
      await db.user.count({
        where: { schoolId: school.id, usernameHash: officeTarget.usernameHash },
      }),
    ).toBe(1);
  });

  it('issue-login without a live can_login link is 409 GUARDIAN_NO_LOGIN_LINK', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const created = await by(actor).create(guardianInput());
    const id = BigInt(created.id);
    const student = await createStudent(db, school);
    const noLogin = await linkGuardian(db, school, student, { id }, { canLogin: false });
    // An ended link with can_login does not count either.
    const other = await createStudent(db, school);
    await linkGuardian(db, school, other, { id }, { canLogin: true, endedAt: new Date() });
    actAs(actor);
    expect(await caught(logins.issueLogin(id, {}))).toMatchObject({
      status: 409,
      code: 'GUARDIAN_NO_LOGIN_LINK',
    });
    await db.studentGuardian.update({
      where: { schoolId_id: { schoolId: school.id, id: noLogin.id } },
      data: { canLogin: true },
    });
    actAs(actor);
    await expect(logins.issueLogin(id, {})).resolves.toMatchObject({ guardianId: created.id });
  });

  it('issue-login refuses linking onto a student login: 409 USERNAME_IN_USE', async () => {
    const school = await createSchool();
    const actor = await staffActor(school);
    const digits = randomIdentityDigits();
    const student = await createStudent(db, school, { bForm: digits });
    await db.user.create({
      data: {
        schoolId: school.id,
        usernameHash: testIdentityHash(digits),
        passwordHash: await passwords.hash(digits),
        studentId: student.id,
      },
    });
    const created = await by(actor).create(guardianInput({ cnic: digits }));
    expect(await caught(loginsBy(actor).issueLogin(BigInt(created.id), {}))).toMatchObject({
      status: 409,
      code: 'USERNAME_IN_USE',
    });
    expect(await db.user.count({ where: { schoolId: school.id, guardianId: { not: null } } })).toBe(
      0,
    );
  });
});
