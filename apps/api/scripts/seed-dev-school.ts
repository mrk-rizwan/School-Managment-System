// pnpm --filter @asms/api seed:dev-school (contracts/slice-15.md §13.3, slice-16.md §15.3).
//
// Creates one development school and its principal, through the API's own services (the same
// code the platform console runs, audit rows included), not over HTTP. For CI's mobile job and
// for developers: it replaces the README's manual "first school and principal" steps.
//
//   DEV_SCHOOL_PRINCIPAL_CNIC   required; 13 digits, dashes allowed. Also the default password.
//   DEV_SCHOOL_CODE             default "demo"
//   DEV_SCHOOL_NAME             default "Demo School"
//   DEV_SCHOOL_PRINCIPAL_NAME   default "Demo Principal"
//   DEV_SCHOOL_PRINCIPAL_PHONE  required (no live-looking default)
//   ALLOW_DEV_SEED=1            allows a database host that is not localhost/127.0.0.1/::1
//
// With DEV_SCHOOL_CLASSROOM=1 it then adds the classroom the mobile flows run against (slice-16
// §15.3): a teacher (DEV_SCHOOL_TEACHER_CNIC, _PHONE, optional _NAME) who is class teacher of
// Class 5 A and teaches English in 5 B; 30 students in 5 A and 5 in 5 B; a guardian
// (DEV_SCHOOL_GUARDIAN_CNIC, _PHONE, optional _NAME) of 5 A roll 1 with a login; and today's
// English diary entry in 5 A with a 64 × 64 PNG. Every row is written through the API's own HTTP
// routes, as the principal and then the teacher would write them — the real guards, validation
// and services, never SQL. No register, remark or announcement: 5 A and 5 B start unrecorded.
// It also clears the school's weekly off days, so "today" is a teaching day whatever day CI runs.
// It needs Redis and object storage reachable (the upload). The principal keeps the CNIC as the
// password, recorded as changed so rule 24 lets it issue the logins
// (recordDevPrincipalPasswordChanged). Prints `classroom created` or `classroom exists`.
//
// Needs the platform admin (seed:platform-admin) as the acting platform user. Idempotent: an
// existing school is reused and an existing principal is left as it is. Prints `created` or
// `exists`, never an identity number. Refuses NODE_ENV=production, a non-loopback database
// host unless ALLOW_DEV_SEED=1, and CI's well-known identity numbers on any non-loopback host
// (scripts/seed-dev-guard.ts); prints which condition allowed it.
//
// Runs under ts-node (not tsx): Nest's constructor injection needs the decorator metadata that
// tsc emits and esbuild does not.
import 'reflect-metadata';
import { Logger, Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ErrorCode, todayInSchool } from '@asms/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { CryptoModule } from '../src/common/crypto/crypto.module';
import { ApiException } from '../src/common/errors/api-exception';
import { LOG_DESTINATION } from '../src/common/logging';
import {
  EnvError,
  EnvModule,
  loadEnv,
  mobileMinAppVersion,
  normaliseEmail,
  seedAdminCredentials,
} from '../src/config/env';
import { AccessModule } from '../src/modules/access/access.module';
import { PrincipalLoginModule } from '../src/modules/platform/principal/principal.module';
import { PrincipalLoginService } from '../src/modules/platform/principal/principal.service';
import { PlatformSchoolsModule } from '../src/modules/platform/schools/platform-schools.module';
import { SchoolsService } from '../src/modules/platform/schools/schools.service';
import { PlatformUserRepository } from '../src/repositories/platform/platform-user.repository';
import { SchoolRepository } from '../src/repositories/platform/school.repository';
import { PRISMA_CLIENT, type GuardedPrismaClient } from '../src/repositories/prisma';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import {
  assertSeedAllowed,
  readClassroomSettings,
  readSeedSettings,
  SeedRefusal,
  type ClassroomSettings,
  type SeedPerson,
} from './seed-dev-guard';

@Module({
  imports: [
    EnvModule,
    TenancyModule,
    CryptoModule,
    AccessModule,
    PlatformSchoolsModule,
    PrincipalLoginModule,
  ],
  providers: [PlatformUserRepository, SchoolRepository],
})
class SeedModule {}

export class SeedError extends Error {}

// --- The classroom, over HTTP ------------------------------------------------------------------

/** Ten names each; students take them in turn with a roll-number suffix where needed. */
const FIRST_NAMES = [
  'Ali',
  'Sara',
  'Bilal',
  'Hina',
  'Usman',
  'Ayesha',
  'Hamza',
  'Zainab',
  'Omar',
  'Fatima',
  'Ahmed',
  'Maryam',
  'Hassan',
  'Amna',
  'Saad',
  'Iqra',
  'Faisal',
  'Noor',
  'Danish',
  'Sana',
  'Imran',
  'Rabia',
  'Kashif',
  'Mahnoor',
  'Junaid',
  'Laiba',
  'Tariq',
  'Mehwish',
  'Waqas',
  'Areeba',
  'Adeel',
  'Kiran',
  'Shahid',
  'Nimra',
  'Zubair',
];
const FAMILY_NAMES = [
  'Raza',
  'Khan',
  'Ahmed',
  'Iqbal',
  'Tariq',
  'Malik',
  'Shah',
  'Butt',
  'Qureshi',
  'Siddiqui',
];

/** The classroom's shape (slice-16 §15.3). */
export const CLASSROOM = {
  className: 'Class 5',
  sections: { A: 30, B: 5 },
  subject: 'English',
  diaryTopic: 'Reading: chapter 3',
} as const;

type ApiCall = <T>(
  method: string,
  path: string,
  options?: { token?: string; body?: unknown; form?: FormData; idempotencyKey?: string },
) => Promise<T>;

/** A JSON client for one base URL. A refusal throws `<status> <code>`, never the body. */
export function apiClient(baseUrl: string, appVersion: string): ApiCall {
  return async <T>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; form?: FormData; idempotencyKey?: string } = {},
  ): Promise<T> => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-App-Version': appVersion,
    };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    for (let attempt = 1; ; attempt += 1) {
      response = await fetch(`${baseUrl}/api/v1${path}`, {
        method,
        headers,
        body:
          options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      });
      // The identity-probe budget (30 a minute per user) is the API's own: wait it out.
      if (response.status !== 429 || attempt > 5) break;
      const wait = Math.min(Number(response.headers.get('Retry-After')) || 30, 65);
      console.log(`rate limited; waiting ${wait} s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    const text = await response.text();
    const parsed = text === '' ? null : (JSON.parse(text) as unknown);
    if (!response.ok) {
      const error = (
        parsed as {
          error?: { code?: string; details?: { fields?: { path?: string; code?: string }[] } };
        } | null
      )?.error;
      // The code and the refused field names only: never a value.
      const fields = (error?.details?.fields ?? []).map((f) => `${f.path}:${f.code}`).join(',');
      throw new SeedHttpError(
        response.status,
        `${error?.code ?? 'UNKNOWN'}${fields ? ` [${fields}]` : ''}`,
        `${method} ${path.split('?')[0]}`,
      );
    }
    return parsed as T;
  };
}

export class SeedHttpError extends SeedError {
  constructor(
    readonly status: number,
    readonly code: string,
    where: string,
  ) {
    super(`${where}: ${status} ${code}`);
  }
}

type Page<T> = { data: T[] };
type Id = { id: string };

/** The academic year covering `today`: April to March. */
export function yearFor(today: string): { name: string; startsOn: string; endsOn: string } {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const start = month >= 4 ? year : year - 1;
  return {
    name: `${start}-${String((start + 1) % 100).padStart(2, '0')}`,
    startsOn: `${start}-04-01`,
    endsOn: `${start + 1}-03-31`,
  };
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** A 64 × 64 PNG, made here (no file in the repository). */
async function tinyPng(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 29, g: 90, b: 176 } },
  })
    .png()
    .toBuffer();
}

/**
 * Seeds the classroom through the API at `baseUrl`, as the school's principal (signing in with the
 * CNIC digits, recorded as a changed password: recordDevPrincipalPasswordChanged) and then as the
 * teacher. Idempotent: finds what exists, creates
 * what does not. Returns whether anything was created.
 */
export async function seedClassroom(
  baseUrl: string,
  appVersion: string,
  school: { shortCode: string; principalCnic: string },
  people: ClassroomSettings,
  /** Students per section; a test seeds fewer (the admission route allows 30 a minute). */
  sizes: { A: number; B: number } = CLASSROOM.sections,
): Promise<boolean> {
  const api = apiClient(baseUrl, appVersion);
  let created = false;
  const login = async (cnic: string) =>
    (
      await api<{ bearerToken: string }>('POST', '/auth/login', {
        body: { schoolCode: school.shortCode, username: cnic, password: cnic, channel: 'bearer' },
      })
    ).bearerToken;

  const token = await login(school.principalCnic);
  const as = { token };
  const today = todayInSchool();
  // The flows run on any day of the week: no weekly off days in the fixture school.
  await api('PATCH', '/school/settings', { ...as, body: { weeklyOffDays: [] } });

  // The academic year covering today, active.
  const wanted = yearFor(today);
  const years = await api<
    Page<Id & { name: string; startsOn: string; endsOn: string; status: string }>
  >('GET', '/academic-years?limit=50', as);
  type Year = Id & { name: string; startsOn: string; endsOn: string; status: string };
  let year: Year | undefined = years.data.find(
    (y) => y.startsOn <= today && today <= y.endsOn && y.status === 'active',
  );
  if (year === undefined) {
    const named: Year =
      years.data.find((y) => y.name === wanted.name) ??
      (await api<Year>('POST', '/academic-years', { ...as, body: wanted }));
    if (named.status !== 'active') await api('POST', `/academic-years/${named.id}/activate`, as);
    year = named;
    created = true;
  }
  // The students were admitted a fortnight back (the roster has a history); the teacher's
  // assignments start today, as an assignment may not start in the past.
  const from = [year.startsOn, addDays(today, -14)].sort()[1]!;

  // Class 5 (daily register) with sections A and B; the subject English.
  const classes = await api<Page<Id & { name: string }>>(
    'GET',
    `/classes?academicYearId=${year.id}&limit=50`,
    as,
  );
  let klass = classes.data.find((c) => c.name === CLASSROOM.className);
  if (klass === undefined) {
    klass = await api<Id & { name: string }>('POST', '/classes', {
      ...as,
      body: { academicYearId: year.id, name: CLASSROOM.className, attendanceMode: 'daily' },
    });
    created = true;
  }
  const sections = await api<Page<Id & { name: string }>>(
    'GET',
    `/classes/${klass.id}/sections?limit=50`,
    as,
  );
  const sectionIds: Record<'A' | 'B', string> = { A: '', B: '' };
  for (const name of ['A', 'B'] as const) {
    let section = sections.data.find((s) => s.name === name);
    if (section === undefined) {
      section = await api<Id & { name: string }>('POST', `/classes/${klass.id}/sections`, {
        ...as,
        body: { name },
      });
      created = true;
    }
    sectionIds[name] = section.id;
  }
  const subjects = await api<Page<Id & { name: string }>>(
    'GET',
    `/subjects?q=${encodeURIComponent(CLASSROOM.subject)}&limit=50`,
    as,
  );
  let subject = subjects.data.find((s) => s.name === CLASSROOM.subject);
  if (subject === undefined) {
    subject = await api<Id & { name: string }>('POST', '/subjects', {
      ...as,
      body: { name: CLASSROOM.subject },
    });
    created = true;
  }

  // The teacher: staff record, login, class teacher of 5 A, English in 5 B.
  const teacher = await findOrCreateStaff(api, token, people.teacher, from);
  created ||= teacher.created;
  if (teacher.userId === null) {
    await api('POST', `/staff/${teacher.id}/issue-login`, {
      ...as,
      body: { systemRole: 'teacher' },
    });
    created = true;
  }
  const assignments = await api<
    Page<{
      role: string;
      sectionId: string | null;
      subjectId: string | null;
      endsOn: string | null;
      voidedAt: string | null;
    }>
  >('GET', `/staff/${teacher.id}/teacher-assignments?limit=50`, as);
  const live = assignments.data.filter(
    (a) => a.voidedAt === null && (a.endsOn === null || a.endsOn >= today),
  );
  const wantedAssignments = [
    { role: 'class_teacher', sectionId: sectionIds.A, subjectId: null },
    { role: 'subject_teacher', sectionId: sectionIds.B, subjectId: subject.id },
  ];
  for (const a of wantedAssignments) {
    if (
      live.some(
        (l) => l.role === a.role && l.sectionId === a.sectionId && l.subjectId === a.subjectId,
      )
    )
      continue;
    await api('POST', `/staff/${teacher.id}/teacher-assignments`, {
      ...as,
      body: { classId: klass.id, ...a },
    });
    created = true;
  }

  // The students: 30 in 5 A, 5 in 5 B; 5 A roll 1's father is the seeded guardian.
  const guardianId = await findGuardian(api, token, people.guardian.cnic);
  let admittedGuardian = guardianId;
  let n = 0;
  for (const [name, count] of Object.entries(sizes) as ['A' | 'B', number][]) {
    const existing = await api<Page<{ current: { rollNo: number | null } | null }>>(
      'GET',
      `/students?sectionId=${sectionIds[name]}&limit=50`,
      as,
    );
    const rolls = new Set(existing.data.map((s) => s.current?.rollNo));
    for (let roll = 1; roll <= count; roll += 1, n += 1) {
      if (rolls.has(roll)) continue;
      const family = FAMILY_NAMES[n % FAMILY_NAMES.length]!;
      const seeded = name === 'A' && roll === 1;
      const guardian = seeded
        ? {
            relationship: 'father',
            isPrimaryContact: true,
            isFeePayer: true,
            canLogin: true,
            ...(admittedGuardian
              ? { guardianId: admittedGuardian }
              : {
                  newGuardian: {
                    fullName: people.guardian.fullName,
                    cnic: people.guardian.cnic,
                    phone: people.guardian.phone,
                    contactCapability: 'smartphone_data',
                  },
                }),
          }
        : {
            relationship: 'father',
            isPrimaryContact: true,
            isFeePayer: true,
            canLogin: false,
            newGuardian: {
              fullName: `${FIRST_NAMES[(n + 7) % FIRST_NAMES.length]} ${family}`,
              // Made-up numbers in a reserved-looking range, never a real family's.
              phone: `+92300000${String(1000 + n).padStart(4, '0')}`,
              contactCapability: 'keypad',
            },
          };
      await api('POST', '/admissions', {
        ...as,
        idempotencyKey: randomUUID(),
        body: {
          student: {
            fullName: `${FIRST_NAMES[n % FIRST_NAMES.length]} ${family}`,
            dateOfBirth: `2016-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`,
            gender: n % 2 === 0 ? 'male' : 'female',
            admittedOn: from,
          },
          guardians: [guardian],
          enrolment: { classId: klass.id, sectionId: sectionIds[name], rollNo: roll },
        },
      });
      created = true;
      if (seeded) admittedGuardian = await findGuardian(api, token, people.guardian.cnic);
    }
  }
  if (admittedGuardian === null) throw new SeedError('classroom: the guardian was not created');
  const guardian = await api<{ userId: string | null }>(
    'GET',
    `/guardians/${admittedGuardian}`,
    as,
  );
  if (guardian.userId === null) {
    await api('POST', `/guardians/${admittedGuardian}/issue-login`, { ...as, body: {} });
    created = true;
  }
  await api('POST', '/auth/logout', as);

  // Today's English diary entry in 5 A, with a photo, written by the teacher.
  const teacherToken = await login(people.teacher.cnic);
  const entries = await api<Page<Id>>(
    'GET',
    `/sections/${sectionIds.A}/diary-entries?dateFrom=${today}&dateTo=${today}&subjectId=${subject.id}&limit=25`,
    { token: teacherToken },
  );
  if (entries.data.length === 0) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(await tinyPng())], { type: 'image/png' }),
      'board.png',
    );
    const staged = await api<Id>('POST', '/uploads', { token: teacherToken, form });
    await api('POST', `/sections/${sectionIds.A}/diary-entries`, {
      token: teacherToken,
      idempotencyKey: randomUUID(),
      body: {
        date: today,
        subjectId: subject.id,
        topic: CLASSROOM.diaryTopic,
        stagedUploadId: staged.id,
      },
    });
    created = true;
  }
  await api('POST', '/auth/logout', { token: teacherToken });
  return created;
}

async function findOrCreateStaff(
  api: ApiCall,
  token: string,
  person: SeedPerson,
  joinedOn: string,
): Promise<{ id: string; userId: string | null; created: boolean }> {
  const masked = `${person.cnic.slice(0, 5)}-*****-${person.cnic.slice(-1)}`;
  const found = await api<
    Page<Id & { fullName: string; cnicMasked: string | null; userId: string | null }>
  >('GET', `/staff?q=${encodeURIComponent(person.fullName)}&limit=50`, { token });
  const staff = found.data.find((s) => s.fullName === person.fullName && s.cnicMasked === masked);
  if (staff) return { id: staff.id, userId: staff.userId, created: false };
  const made = await api<Id & { userId: string | null }>('POST', '/staff', {
    token,
    body: {
      fullName: person.fullName,
      cnic: person.cnic,
      phone: person.phone,
      designation: 'Teacher',
      joinedOn,
    },
  });
  return { id: made.id, userId: made.userId, created: true };
}

async function findGuardian(api: ApiCall, token: string, cnic: string): Promise<string | null> {
  const hits = await api<{ data: { guardian: Id }[] }>('POST', '/guardians/lookup', {
    token,
    body: { cnic },
  });
  return hits.data[0]?.guardian.id ?? null;
}

/**
 * The real API, in this process, on a loopback port: AppModule with main's Express settings and
 * its request log discarded (it would only repeat the paths).
 */
export async function startApi(): Promise<{ app: NestExpressApplication; baseUrl: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_DESTINATION)
    .useValue({ write: () => undefined })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Rule 24 (R225): a principal on the default password cannot issue logins, and the classroom seed
 * issues the teacher's and the guardian's. A developer would add and verify an email and change the
 * password; the dev seed records the change while keeping the digits as the password, so the
 * mobile flows still sign in with the CNIC. Development and CI only (seed-dev-guard refuses
 * production and non-loopback hosts).
 */
export async function recordDevPrincipalPasswordChanged(
  app: INestApplicationContext,
  schoolId: bigint,
): Promise<void> {
  const db = app.get<GuardedPrismaClient>(PRISMA_CLIENT, { strict: false });
  const principals = await db.userRole.findMany({
    where: { schoolId, systemRole: 'principal', endedAt: null },
    select: { userId: true },
  });
  for (const { userId } of principals) {
    await db.user.updateMany({
      where: { schoolId, id: userId, passwordIsDefault: true },
      data: { passwordIsDefault: false, passwordChangedAt: new Date() },
    });
  }
}

// --- The school and its principal ---------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  const wanted = readSeedSettings(process.env);
  const classroom = readClassroomSettings(process.env, wanted.cnic);
  const allowedBy = assertSeedAllowed(
    {
      NODE_ENV: env.NODE_ENV,
      DATABASE_URL: env.DATABASE_URL,
      ALLOW_DEV_SEED: process.env.ALLOW_DEV_SEED,
    },
    wanted.cnic,
    ...(classroom ? [classroom.teacher.cnic, classroom.guardian.cnic] : []),
  );
  console.log(`seeding allowed: ${allowedBy}`);
  const { email } = seedAdminCredentials(env);

  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error'] });
  try {
    const admin = await app.get(PlatformUserRepository).findByEmail(normaliseEmail(email));
    if (admin === null) throw new SeedError('No platform admin: run seed:platform-admin first');

    let created = false;
    const { rows } = await app.get(SchoolRepository).list({
      q: wanted.shortCode,
      sort: 'name',
      skip: 0,
      take: 50,
    });
    let schoolRowId = rows.find((row) => row.shortCode === wanted.shortCode)?.id;
    if (schoolRowId === undefined) {
      const dto = await app
        .get(SchoolsService)
        .create(admin.id, { name: wanted.name, shortCode: wanted.shortCode });
      schoolRowId = BigInt(dto.id);
      created = true;
    }

    try {
      await app.get(PrincipalLoginService).issue(admin.id, schoolRowId, {
        fullName: wanted.fullName,
        cnic: wanted.cnic,
        phone: wanted.phone,
      });
      created = true;
    } catch (error) {
      const exists =
        error instanceof ApiException &&
        (error.code === ErrorCode.ALREADY_PRINCIPAL ||
          error.code === ErrorCode.ACTIVE_PRINCIPAL_EXISTS);
      if (!exists) throw error;
    }
    if (classroom !== null) await recordDevPrincipalPasswordChanged(app, schoolRowId);
    console.log(created ? 'created' : 'exists');
  } finally {
    await app.close();
  }

  if (classroom === null) return;
  const api = await startApi();
  try {
    const made = await seedClassroom(
      api.baseUrl,
      mobileMinAppVersion(env),
      { shortCode: wanted.shortCode, principalCnic: wanted.cnic },
      classroom,
    );
    console.log(made ? 'classroom created' : 'classroom exists');
  } finally {
    await api.app.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Names only: a database error's message can carry row values.
    if (error instanceof EnvError || error instanceof SeedError || error instanceof SeedRefusal)
      console.error(error.message);
    else if (error instanceof ApiException) console.error(`${error.status} ${error.code}`);
    else new Logger('seed-dev-school').error(error instanceof Error ? error.name : 'failed');
    process.exit(1);
  });
}
