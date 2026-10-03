// pnpm --filter @asms/api seed:platform-admin (contracts/slice-1.md §7).
//
// Creates the platform admin named by PLATFORM_ADMIN_EMAIL with PLATFORM_ADMIN_PASSWORD, who must
// enrol an authenticator and change the password at first sign-in. Idempotent: an existing user
// with that email is left exactly as it is. Prints `created` or `exists`, never the email or the
// password. Run with a different email to add a second admin.
//
// Runs under ts-node (not tsx): Nest's constructor injection needs the decorator metadata that
// tsc emits and esbuild does not.
import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CryptoModule } from '../src/common/crypto/crypto.module';
import { EnvError, EnvModule, loadEnv, seedAdminCredentials } from '../src/config/env';
import { PlatformAdminSeeder } from '../src/modules/platform/auth/platform-admin.seeder';
import { PlatformAuditRepository } from '../src/repositories/platform/platform-audit.repository';
import { PlatformUserRepository } from '../src/repositories/platform/platform-user.repository';
import { TenancyModule } from '../src/tenancy/tenancy.module';

@Module({
  imports: [EnvModule, TenancyModule, CryptoModule],
  providers: [PlatformAdminSeeder, PlatformUserRepository, PlatformAuditRepository],
})
class SeedModule {}

async function main(): Promise<void> {
  // Fail with the list of bad or missing keys before Nest starts. Only the seed requires the two
  // PLATFORM_ADMIN_* keys; the API boots without them.
  const { email, password } = seedAdminCredentials(loadEnv());
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error'] });
  try {
    const result = await app.get(PlatformAdminSeeder).seed(email, password);
    console.log(result);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // An invalid environment names the keys only. Anything else is logged without its message
  // detail, which for a database error can include the row (and so the password hash).
  if (error instanceof EnvError) console.error(error.message);
  else new Logger('seed-platform-admin').error(error instanceof Error ? error.name : 'failed');
  process.exit(1);
});
