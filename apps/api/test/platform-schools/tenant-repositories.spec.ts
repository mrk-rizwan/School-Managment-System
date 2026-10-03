// Control 4 (one isolation test per tenant table) for school_settings and school_counters, through
// the repositories the school-creation transaction uses.
import { Test } from '@nestjs/testing';
import { EnvModule } from '../../src/config/env';
import { SchoolCounterRepository } from '../../src/repositories/school-counter.repository';
import { SchoolSettingsRepository } from '../../src/repositories/school-settings.repository';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { expectIsolated } from '../support/isolation';
import { closeTestDb, createTwoSchools } from '../support/schools';

describe('tenant repositories created with the school', () => {
  let settings: SchoolSettingsRepository;
  let counters: SchoolCounterRepository;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule],
      providers: [SchoolSettingsRepository, SchoolCounterRepository],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    settings = moduleRef.get(SchoolSettingsRepository);
    counters = moduleRef.get(SchoolCounterRepository);
  });

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  it('school_settings: a row written for school A is invisible to school B', async () => {
    await expectIsolated(await createTwoSchools(), {
      create: async (schoolId) => (await settings.create(schoolId, { feeDueDay: 12 })).id,
      // One row per school: B's lookup must not return A's row (B has none of its own).
      read: async (schoolId, id) => {
        const row = await settings.find(schoolId);
        return row && row.id === id ? row : null;
      },
    });
  });

  it('school_settings: new rows start with student login off', async () => {
    const { a } = await createTwoSchools();
    expect(await settings.create(a.id, { feeDueDay: 5 })).toMatchObject({
      feeDueDay: 5,
      studentLoginEnabled: false,
    });
  });

  it('school_counters: a counter written for school A is invisible to school B', async () => {
    await expectIsolated(await createTwoSchools(), {
      create: async (schoolId) => (await counters.create(schoolId, 'admission_no')).id,
      read: async (schoolId, id) => {
        const row = await counters.find(schoolId, 'admission_no');
        return row && row.id === id ? row : null;
      },
    });
  });

  it('school_counters: a new counter starts at 0', async () => {
    const { a } = await createTwoSchools();
    expect(await counters.create(a.id, 'admission_no')).toMatchObject({
      name: 'admission_no',
      value: 0n,
    });
  });
});
