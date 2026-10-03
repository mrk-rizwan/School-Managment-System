// Two-school fixtures (plan 0.6).
//
// Convention: tests never truncate or delete. Each test creates its own schools with unique
// short codes, so tenancy itself keeps tests apart and suites can run in parallel against one
// database. test/guardrails/no-truncate.spec.ts enforces it.
import { randomBytes } from 'node:crypto';
import { createGuardedClient, type GuardedPrismaClient } from '../../src/repositories/prisma';
import type { SchoolStatus } from '../../src/repositories/generated/prisma/client';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createdSchoolRow, fromPlatformSchool } from '../../src/tenancy/school-id.mint';

let client: GuardedPrismaClient | undefined;

/** One guarded client per test file (Jest isolates module state per file). */
export function testDb(): GuardedPrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL is not set; test/setup-env.ts points it at TEST_DATABASE_URL');
  client ??= createGuardedClient(url);
  return client;
}

/** Call from afterAll in any file that used testDb(). */
export async function closeTestDb(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}

/** 3-12 lower-case letters and digits, as schools.short_code requires; random so tests never collide. */
export function uniqueShortCode(): string {
  return `t${BigInt(`0x${randomBytes(8).toString('hex')}`)
    .toString(36)
    .slice(0, 11)}`;
}

export interface TestSchool {
  id: SchoolId;
  shortCode: string;
}

export async function createSchool(
  overrides: { name?: string; status?: SchoolStatus } = {},
): Promise<TestSchool> {
  const row = await testDb().school.create({
    data: {
      name: overrides.name ?? 'Test School',
      shortCode: uniqueShortCode(),
      status: overrides.status ?? 'active',
    },
  });
  return { id: fromPlatformSchool(createdSchoolRow(row)), shortCode: row.shortCode };
}

export interface TwoSchools {
  a: TestSchool;
  b: TestSchool;
}

/** School A owns the data under test; school B is the would-be intruder. */
export async function createTwoSchools(): Promise<TwoSchools> {
  return {
    a: await createSchool({ name: 'School A' }),
    b: await createSchool({ name: 'School B' }),
  };
}
