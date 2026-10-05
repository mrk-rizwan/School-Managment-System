import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { PrincipalLoginService } from '../../src/modules/platform/principal/principal.service';
import { SchoolsService } from '../../src/modules/platform/schools/schools.service';
import {
  apiClient,
  recordDevPrincipalPasswordChanged,
  seedClassroom,
  SeedHttpError,
} from '../../scripts/seed-dev-school';
import { createTestApp } from '../core/app';
import { createPlatformUser } from '../support/platform';
import { randomIdentityDigits } from '../support/school-session';
import { closeTestDb, uniqueShortCode } from '../support/schools';

// contracts/slice-16.md §15.3: the classroom fixture behind DEV_SCHOOL_CLASSROOM=1, run against
// the test database through the real API (in this process, on a loopback port). It is
// idempotent, it builds what the mobile flows need, and it prints no identity number. Fewer
// students than the script's 30 + 5 keep the run inside the admission route's 30-a-minute budget.

jest.setTimeout(120_000);

let app: NestExpressApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await createTestApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

test('seeds the classroom once, finds it the second time, and prints no identity number', async () => {
  const admin = await createPlatformUser();
  const shortCode = uniqueShortCode();
  const principal = randomIdentityDigits();
  const people = {
    teacher: { cnic: randomIdentityDigits(), phone: '+923000000001', fullName: 'Seed Teacher' },
    guardian: { cnic: randomIdentityDigits(), phone: '+923000000002', fullName: 'Seed Guardian' },
  };
  const school = await app.get(SchoolsService).create(admin.id, { name: 'Seed School', shortCode });
  await app.get(PrincipalLoginService).issue(admin.id, BigInt(school.id), {
    fullName: 'Seed Principal',
    cnic: principal,
    phone: '+923000000000',
  });
  await recordDevPrincipalPasswordChanged(app, BigInt(school.id));
  const printed = jest.spyOn(console, 'log').mockImplementation(() => undefined);

  const sizes = { A: 3, B: 1 };
  const where = { shortCode, principalCnic: principal };
  expect(await seedClassroom(baseUrl, '0.0.0', where, people, sizes)).toBe(true);
  expect(await seedClassroom(baseUrl, '0.0.0', where, people, sizes)).toBe(false);

  // What the flows rely on, as the teacher and the guardian see it.
  const api = apiClient(baseUrl, '0.0.0');
  const signIn = async (cnic: string) =>
    (
      await api<{ bearerToken: string }>('POST', '/auth/login', {
        body: { schoolCode: shortCode, username: cnic, password: cnic, channel: 'bearer' },
      })
    ).bearerToken;
  const teacherToken = await signIn(people.teacher.cnic);
  type Me = {
    assignments: { role: string; sectionId: string; subjectName: string | null }[];
    children: { studentId: string; current: { rollNo: number; sectionName: string } | null }[];
  };
  const teacherMe = await api<Me>('GET', '/me', { token: teacherToken });
  expect(teacherMe.assignments.map((a) => [a.role, a.subjectName]).sort()).toEqual([
    ['class_teacher', null],
    ['subject_teacher', 'English'],
  ]);
  const sectionA = teacherMe.assignments.find((a) => a.role === 'class_teacher')!.sectionId;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  const view = await api<{ register: unknown; teachingDay: boolean; roster: unknown[] }>(
    'GET',
    `/sections/${sectionA}/register?date=${today}&period=1`,
    { token: teacherToken },
  );
  expect(view).toMatchObject({ register: null, teachingDay: true });
  expect(view.roster).toHaveLength(sizes.A);
  const diary = await api<{ data: { topic: string; hasAttachment: boolean }[] }>(
    'GET',
    `/sections/${sectionA}/diary-entries?dateFrom=${today}&dateTo=${today}`,
    { token: teacherToken },
  );
  expect(diary.data).toEqual([
    expect.objectContaining({ topic: 'Reading: chapter 3', hasAttachment: true }),
  ]);

  const guardianMe = await api<Me>('GET', '/me', { token: await signIn(people.guardian.cnic) });
  expect(guardianMe.children).toEqual([
    expect.objectContaining({ current: expect.objectContaining({ rollNo: 1, sectionName: 'A' }) }),
  ]);

  const output = printed.mock.calls.flat().join('\n');
  for (const digits of [principal, people.teacher.cnic, people.guardian.cnic]) {
    expect(output).not.toContain(digits);
  }
  expect(output).not.toMatch(/\d{5}-?\d{7}-?\d/);
  printed.mockRestore();
});

test('a refusal names the route, the status and the code — never a value', async () => {
  const api = apiClient(baseUrl, '0.0.0');
  const digits = randomIdentityDigits();
  const refused = await api('POST', '/auth/login', {
    body: { schoolCode: 'nosuchschool', username: digits, password: digits, channel: 'bearer' },
  }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(SeedHttpError);
  expect((refused as Error).message).toMatch(/^POST \/auth\/login: (401|422) /);
  expect((refused as Error).message).not.toContain(digits);
});
