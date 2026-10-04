// pnpm --filter @asms/api seed:dev-school (contracts/slice-15.md §13.3).
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
// Needs the platform admin (seed:platform-admin) as the acting platform user. Idempotent: an
// existing school is reused and an existing principal is left as it is. Prints `created` or
// `exists`, never the identity number. Refuses NODE_ENV=production, a non-loopback database
// host unless ALLOW_DEV_SEED=1, and CI's well-known identity number on any non-loopback host
// (scripts/seed-dev-guard.ts); prints which condition allowed it.
//
// Runs under ts-node (not tsx): Nest's constructor injection needs the decorator metadata that
// tsc emits and esbuild does not.
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ErrorCode } from '@asms/shared';
import { CryptoModule } from '../src/common/crypto/crypto.module';
import { ApiException } from '../src/common/errors/api-exception';
import {
  EnvError,
  EnvModule,
  loadEnv,
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
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { assertSeedAllowed, readSeedSettings, SeedRefusal } from './seed-dev-guard';

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

class SeedError extends Error {}

async function main(): Promise<void> {
  const env = loadEnv();
  const wanted = readSeedSettings(process.env);
  const allowedBy = assertSeedAllowed(
    {
      NODE_ENV: env.NODE_ENV,
      DATABASE_URL: env.DATABASE_URL,
      ALLOW_DEV_SEED: process.env.ALLOW_DEV_SEED,
    },
    wanted.cnic,
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
    console.log(created ? 'created' : 'exists');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // Names only: a database error's message can carry row values.
  if (error instanceof EnvError || error instanceof SeedError || error instanceof SeedRefusal)
    console.error(error.message);
  else if (error instanceof ApiException) console.error(`${error.status} ${error.code}`);
  else new Logger('seed-dev-school').error(error instanceof Error ? error.name : 'failed');
  process.exit(1);
});
