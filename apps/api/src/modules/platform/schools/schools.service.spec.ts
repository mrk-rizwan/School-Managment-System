// The give-up paths of SchoolsService: a row that changes under every attempt. A real race cannot
// be lost three times on demand, so the repository's lock / compare-and-set is made to fail.
import { Test } from '@nestjs/testing';
import { EnvModule } from '../../../config/env';
import { ApiException } from '../../../common/errors/api-exception';
import { PlatformAuditRepository } from '../../../repositories/platform/platform-audit.repository';
import { SchoolRepository } from '../../../repositories/platform/school.repository';
import { SchoolCounterRepository } from '../../../repositories/school-counter.repository';
import { SchoolSettingsRepository } from '../../../repositories/school-settings.repository';
import { TenancyModule } from '../../../tenancy/tenancy.module';
import { closeTestDb, createSchool, testDb } from '../../../../test/support/schools';
import { SchoolsService } from './schools.service';

describe('SchoolsService when the row keeps changing', () => {
  let service: SchoolsService;
  let schools: SchoolRepository;
  let close: () => Promise<void>;
  const actor = 1n; // never written: neither path reaches the audit row

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule],
      providers: [
        SchoolsService,
        SchoolRepository,
        SchoolSettingsRepository,
        SchoolCounterRepository,
        PlatformAuditRepository,
      ],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    service = moduleRef.get(SchoolsService);
    schools = moduleRef.get(SchoolRepository);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  const caught = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected an ApiException');
      },
      (e: unknown) => {
        if (!(e instanceof ApiException)) throw e;
        return e;
      },
    );

  it('change-status gives up with 409 ILLEGAL_STATUS_TRANSITION and details { from, to }', async () => {
    const school = await createSchool({ status: 'active' });
    const cas = jest.spyOn(schools, 'changeStatus').mockResolvedValue(0);
    const error = await caught(
      service.changeStatus(actor, school.id, { status: 'suspended', reason: 'Unpaid' }),
    );
    expect(error).toMatchObject({
      status: 409,
      code: 'ILLEGAL_STATUS_TRANSITION',
      details: { from: 'active', to: 'suspended' },
    });
    expect(cas).toHaveBeenCalledTimes(3);
    const row = await testDb().school.findUnique({ where: { id: school.id } });
    expect(row?.status).toBe('active');
  });

  it('PATCH gives up with 409 CONCURRENT_UPDATE, the row unchanged', async () => {
    const school = await createSchool({ name: 'Busy' });
    const lock = jest.spyOn(schools, 'lockIfUnchanged').mockResolvedValue(false);
    const error = await caught(service.update(actor, school.id, { name: 'Never' }));
    expect(error).toMatchObject({ status: 409, code: 'CONCURRENT_UPDATE' });
    expect(lock).toHaveBeenCalledTimes(3);
    const row = await testDb().school.findUnique({ where: { id: school.id } });
    expect(row?.name).toBe('Busy');
  });
});
