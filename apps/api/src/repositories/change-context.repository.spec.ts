// ChangeContextRepository (plan §4.6): the actor and reason it writes are transaction-local, reach
// the history trigger inside the same interactive transaction, and are gone after it. Outside a
// transaction the update is refused (fail-closed).
import { Test } from '@nestjs/testing';
import { TransactionHost } from '@nestjs-cls/transactional';
import { ClsService } from 'nestjs-cls';
import { createMark, createRegister } from '../../test/attendance/support';
import { createSchoolUser } from '../../test/support/school-session';
import { closeTestDb, createSchool, testDb } from '../../test/support/schools';
import { createClassWithSection, createStudent, enrol } from '../../test/support/students';
import { summariseDatabaseError } from '../common/errors/prisma-errors';
import { EnvModule } from '../config/env';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ChangeContextRepository } from './change-context.repository';
import type { PrismaTxAdapter } from './prisma';

describe('ChangeContextRepository', () => {
  let repo: ChangeContextRepository;
  let cls: ClsService;
  let txHost: TransactionHost<PrismaTxAdapter>;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EnvModule, TenancyModule],
      providers: [ChangeContextRepository],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    repo = moduleRef.get(ChangeContextRepository);
    cls = moduleRef.get(ClsService);
    txHost = moduleRef.get(TransactionHost);
  });

  afterAll(async () => {
    await close();
    await closeTestDb();
  });

  const settings = async () =>
    (
      await txHost.tx.$queryRaw<{ actor: string | null; reason: string | null }[]>`
        SELECT current_setting('asms.actor_user_id', true) AS actor,
               current_setting('asms.change_reason', true) AS reason`
    )[0];

  /** The constraint the error mapper reads from a refused write (DETAIL 'constraint: <name>'). */
  const refusal = (work: Promise<unknown>) =>
    work.then(
      () => 'accepted',
      (error: unknown) => summariseDatabaseError(error)?.constraint,
    );

  async function absentMark() {
    const school = await createSchool();
    const teacher = await createSchoolUser(testDb(), school, { systemRole: 'teacher' });
    const { section } = await createClassWithSection(testDb(), school);
    const enrolment = await enrol(testDb(), school, await createStudent(testDb(), school), section);
    const register = await createRegister(testDb(), school.id, section, teacher.userId);
    const mark = await createMark(testDb(), school.id, register, enrolment.id, 'absent');
    return { school, teacher, mark };
  }

  it('sets both values for the transaction only', async () => {
    const seen = await cls.run(() =>
      txHost.withTransaction(async () => {
        await repo.setChangeContext(42n, 'Arrived at 09:40');
        return settings();
      }),
    );
    expect(seen).toEqual({ actor: '42', reason: 'Arrived at 09:40' });
    // The next transaction, whichever pooled connection it gets, sees nothing.
    for (let i = 0; i < 3; i++) {
      const after = await cls.run(() => txHost.withTransaction(() => settings()));
      expect(after?.actor ?? '').toBe('');
      expect(after?.reason ?? '').toBe('');
    }
  });

  it('feeds the history trigger inside the transaction; a null reason is no reason', async () => {
    const { school, teacher, mark } = await absentMark();
    const amend = () =>
      txHost.tx.attendanceMark.updateMany({
        where: { schoolId: school.id, id: mark.id },
        data: { status: 'late' },
      });
    expect(
      await refusal(
        cls.run(() =>
          txHost.withTransaction(async () => {
            await repo.setChangeContext(teacher.userId, null);
            await amend();
          }),
        ),
      ),
    ).toBe('attendance_mark_changes_reason_required');
    await cls.run(() =>
      txHost.withTransaction(async () => {
        await repo.setChangeContext(teacher.userId, 'Arrived at 09:40');
        await amend();
      }),
    );
    const changes = await testDb().attendanceMarkChange.findMany({
      where: { schoolId: school.id, markId: mark.id },
      select: { changedBy: true, reason: true, oldStatus: true, newStatus: true },
    });
    expect(changes).toEqual([
      { changedBy: teacher.userId, reason: 'Arrived at 09:40', oldStatus: 'absent', newStatus: 'late' },
    ]);
  });

  it('outside a transaction the context does not reach the update: refused', async () => {
    const { school, teacher, mark } = await absentMark();
    expect(
      await refusal(
        cls.run(async () => {
          await repo.setChangeContext(teacher.userId, 'Arrived at 09:40');
          await txHost.tx.attendanceMark.updateMany({
            where: { schoolId: school.id, id: mark.id },
            data: { status: 'late' },
          });
        }),
      ),
    ).toBe('attendance_mark_changes_actor_required');
  });
});
