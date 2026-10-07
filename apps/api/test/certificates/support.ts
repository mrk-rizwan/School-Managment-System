// Slice 34 test support: CertificateRepository in a small module over the guarded client, with
// the school-wide scope a principal's certificate.issue gives, to probe the repository directly
// (control 4) as the academic isolation suite does for the other wave N tables.
import { Test } from '@nestjs/testing';
import { Capability } from '@asms/shared';
import { EnvModule } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { CertificateRepository } from '../../src/repositories/certificate.repository';
import type { Scope } from '../../src/tenancy/scope';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import type { TestSchool } from '../support/schools';

export async function certificateRepositoryAs(
  school: TestSchool,
  principalUserId: bigint,
): Promise<{ repo: CertificateRepository; all: Scope; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({
    imports: [EnvModule, TenancyModule, AccessModule],
    providers: [CertificateRepository],
  }).compile();
  await moduleRef.init();
  const permissions = moduleRef.get(PermissionsService);
  const access = await permissions.load(school.id, principalUserId);
  const all = access && (await permissions.can(school.id, access, Capability.CERTIFICATE_ISSUE));
  if (!all || all.kind !== 'all') throw new Error('expected a school-wide scope');
  return { repo: moduleRef.get(CertificateRepository), all, close: () => moduleRef.close() };
}
