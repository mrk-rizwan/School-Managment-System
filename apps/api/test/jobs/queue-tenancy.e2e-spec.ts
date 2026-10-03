// The fifth SchoolId constructor and the worker's CLS context (Phase 2 plan §4.1, R113;
// src/tenancy/queue.mint.ts). Slice 9's processors build on these; their own tests (replayed and
// forged jobs, R105) come with them.
import { Test, type TestingModule } from '@nestjs/testing';
import { EnvModule } from '../../src/config/env';
import { QueueTenancy, QueueTenancyModule } from '../../src/tenancy/queue.mint';
import { RequestContextService } from '../../src/tenancy/request-context';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { closeTestDb, createSchool } from '../support/schools';

describe('queue payload tenancy (R113)', () => {
  let moduleRef: TestingModule;
  let queue: QueueTenancy;
  let context: RequestContextService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule, QueueTenancyModule],
    }).compile();
    await moduleRef.init();
    queue = moduleRef.get(QueueTenancy);
    context = moduleRef.get(RequestContextService);
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  it('resolves a well-formed payload to its school and its ids; a suspended school runs as an active one', async () => {
    for (const status of ['active', 'trial', 'suspended'] as const) {
      const school = await createSchool({ status });
      const job = await queue.fromQueuePayload(
        { schoolId: school.id.toString(), messageId: '42' },
        ['messageId'],
      );
      expect(job).toEqual({ schoolId: school.id, ids: { messageId: 42n } });
    }
  });

  it('drops a terminated or unknown school', async () => {
    const terminated = await createSchool({ status: 'terminated' });
    expect(
      await queue.fromQueuePayload({ schoolId: terminated.id.toString(), messageId: '1' }, ['messageId']),
    ).toBeNull();
    expect(
      await queue.fromQueuePayload({ schoolId: '9223372036854775807', messageId: '1' }, ['messageId']),
    ).toBeNull();
  });

  it.each([
    ['an extra key', { schoolId: '1', messageId: '1', phone: '+923001234567' }],
    ['a missing id', { schoolId: '1' }],
    ['a numeric value', { schoolId: 1, messageId: '1' }],
    ['a non-numeric id', { schoolId: '1', messageId: 'abc' }],
    ['a leading zero', { schoolId: '01', messageId: '1' }],
    ['zero', { schoolId: '0', messageId: '1' }],
    ['an id beyond bigint', { schoolId: '9223372036854775808', messageId: '1' }],
    ['a non-object', 'schoolId=1'],
    ['null', null],
  ])('drops a payload with %s, without reading a school', async (_label, payload) => {
    expect(await queue.fromQueuePayload(payload, ['messageId'])).toBeNull();
  });

  it('runs each job body in its own context: concurrent jobs for two schools keep their tenants', async () => {
    const a = await createSchool();
    const b = await createSchool();
    const [jobA, jobB] = await Promise.all([
      queue.fromQueuePayload({ schoolId: a.id.toString() }, []),
      queue.fromQueuePayload({ schoolId: b.id.toString() }, []),
    ]);
    if (!jobA || !jobB) throw new Error('both schools resolve');
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
    const body = (expected: bigint) => async () => {
      const seen: (bigint | undefined)[] = [];
      for (let i = 0; i < 5; i++) {
        seen.push(context.schoolId);
        await pause();
      }
      return seen.every((id) => id === expected);
    };
    // Interleaved: each body yields between reads while the other runs.
    const results = await Promise.all([
      queue.runAsSchool(jobA.schoolId, body(a.id)),
      queue.runAsSchool(jobB.schoolId, body(b.id)),
    ]);
    expect(results).toEqual([true, true]);
    expect(context.schoolId).toBeUndefined();
  });
});
