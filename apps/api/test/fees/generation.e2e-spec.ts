// Slice 19's generation, late fees and the stale sweep, driven as the worker drives them (inside
// runAsSchool, with a chosen clock): R179-R182, R184's run record, R185, R240, R241, R242, R252,
// and A1's daily catch-up. The real AppModule and database.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { concessionAmount } from '@asms/shared';
import { ChargeRunRepository } from '../../src/repositories/charge-run.repository';
import { createTestApp } from '../core/app';
import { asSchool } from '../messaging/support';
import { createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { closeTestDb } from '../support/schools';
import { createGuardian, createSection, day, type TestAcademicYear } from '../support/students';
import {
  chargesOf,
  classWithSection,
  daily,
  db,
  financeSchool,
  generation,
  karachi,
  lateFees,
  pupil,
  reenrol,
  runMonth,
  session2026,
  structure,
  type FinanceSchool,
} from './charges-support';

describe('slice 19: charge generation, late fees and the stale sweep (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  /** A school, its 2026-27 session, one priced class (tuition 3,000, annual 5,000) and a principal. */
  async function setup(): Promise<
    FinanceSchool & { year: TestAcademicYear; classId: bigint; section: Awaited<ReturnType<typeof classWithSection>>['section']; principal: TestSchoolUser }
  > {
    const fs = await financeSchool();
    const principal = await createSchoolUser(db(), fs.school, { systemRole: 'principal' });
    const year = await session2026(fs.school);
    const { classId, section } = await classWithSection(fs.school, year);
    await structure(fs.school, { academicYearId: year.id, classId, feeHeadId: fs.heads.tuition, amount: 3000, effectiveFrom: '2026-04' }, principal.userId);
    await structure(fs.school, { academicYearId: year.id, classId, feeHeadId: fs.heads.annual, amount: 5000, effectiveFrom: '2026-04' }, principal.userId);
    return { ...fs, year, classId, section, principal };
  }

  const tuitionOf = async (fs: FinanceSchool, studentId: bigint, period: string) =>
    db().charge.findMany({ where: { schoolId: fs.school.id, studentId, feeHeadId: fs.heads.tuition, period, kind: 'generated' } });

  it('R179, R241: the 1st charges the month once per student and head; a re-run inserts nothing; the run records it', async () => {
    const s = await setup();
    const a = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    const b = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    await daily(app, s.school, karachi('2026-10-01', 1));
    const first = await chargesOf(s.school);
    // Tuition for October and the year's annual charge, for each student.
    expect(first.map((c) => [c.studentId, c.feeHeadId, c.period, c.amount, c.status, c.headFrequency]).sort()).toEqual(
      [
        [a.studentId, s.heads.tuition, '2026-10', 3000, 'open', 'monthly'],
        [a.studentId, s.heads.annual, null, 5000, 'open', 'yearly'],
        [b.studentId, s.heads.tuition, '2026-10', 3000, 'open', 'monthly'],
        [b.studentId, s.heads.annual, null, 5000, 'open', 'yearly'],
      ].sort(),
    );
    // Due on the period's fee due day (R240: not born late), written by the job (created_by null).
    expect(first.every((c) => c.dueOn.toISOString().startsWith('2026-10-10') && c.createdBy === null)).toBe(true);
    const runs = await db().chargeRun.findMany({ where: { schoolId: s.school.id } });
    expect(runs.map((r) => [r.status, r.period, r.kind, r.triggeredBy, r.chargesInserted, r.studentsCharged, r.chargesSkipped])).toEqual([
      ['done', '2026-10', 'monthly', null, 4, 2, 0],
    ]);

    // A manual re-run inserts nothing and counts what it skipped.
    const again = await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-02'));
    expect((await chargesOf(s.school)).length).toBe(4);
    const rerun = await db().chargeRun.findFirstOrThrow({ where: { schoolId: s.school.id, id: again } });
    expect([rerun.status, rerun.chargesInserted, rerun.chargesSkipped]).toEqual(['done', 0, 4]);

    // fee_charged: one message per fee-payer guardian of the first run, subject the run.
    const messages = await db().message.findMany({ where: { schoolId: s.school.id, type: 'fee_charged' } });
    expect(messages.map((m) => m.guardianId).sort()).toEqual([a.guardianId, b.guardianId].sort());
    expect(new Set(messages.map((m) => m.subjectId))).toEqual(new Set([runs[0]?.id]));
    expect(messages[0]?.body).toContain('Rs 8,000');
  });

  it('R241: siblings with one fee payer get one message with the family total; a 0 total gets none', async () => {
    const s = await setup();
    const parent = await createGuardian(db(), s.school);
    const a = await pupil(s.school, s.section, { startedOn: '2026-04-01', guardianId: parent.id, fullName: 'Ali Raza' });
    const b = await pupil(s.school, s.section, { startedOn: '2026-04-01', guardianId: parent.id, fullName: 'Sara Raza' });
    // A third child free on everything: charged, settled at birth, told nothing.
    const free = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    const enrolment = await db().enrolment.findFirstOrThrow({ where: { schoolId: s.school.id, id: free.enrolmentId } });
    const concession = await db().concession.create({
      data: {
        schoolId: s.school.id, studentId: free.studentId, academicYearId: s.year.id, enrolmentId: enrolment.id,
        kind: 'percentage', value: 100, effectiveFrom: '2026-04', reason: 'Orphan support', requestedBy: s.principal.userId,
        status: 'approved', decidedBy: s.principal.userId, decidedAt: new Date(),
      },
    });
    await db().concessionHead.createMany({
      data: [s.heads.tuition, s.heads.annual].map((feeHeadId) => ({ schoolId: s.school.id, concessionId: concession.id, feeHeadId })),
    });
    await daily(app, s.school, karachi('2026-10-01', 1));
    const freeCharges = await db().charge.findMany({ where: { schoolId: s.school.id, studentId: free.studentId } });
    expect(freeCharges.map((c) => [c.amount, c.status, c.concessionId])).toEqual([
      [0, 'settled', concession.id],
      [0, 'settled', concession.id],
    ]);
    const messages = await db().message.findMany({ where: { schoolId: s.school.id, type: 'fee_charged' } });
    expect(messages.map((m) => m.guardianId)).toEqual([parent.id]);
    expect(messages[0]?.body).toContain('Rs 16,000');
    expect(messages[0]?.body).toContain('Ali Raza');
    expect(messages[0]?.body).toContain('Sara Raza');
    void a;
    void b;
  });

  it('R179, R180, R181: section change, class change, withdraw-and-readmit each yield one charge, for the class active on the 1st', async () => {
    const s = await setup();
    const other = await classWithSection(s.school, s.year);
    await structure(s.school, { academicYearId: s.year.id, classId: other.classId, feeHeadId: s.heads.tuition, amount: 4000, effectiveFrom: '2026-04' }, s.principal.userId);
    await structure(s.school, { academicYearId: s.year.id, classId: other.classId, feeHeadId: s.heads.annual, amount: 5000, effectiveFrom: '2026-04' }, s.principal.userId);
    const sameClassSection = await createSection(db(), s.school, { id: s.classId, academicYearId: s.year.id });

    // Section change on the 10th: old enrolment ended the 9th, new one from the 10th.
    const moved = await pupil(s.school, s.section, { startedOn: '2026-04-01', endedOn: '2026-10-09' });
    await reenrol(s.school, moved.studentId, sameClassSection, '2026-10-10');
    // Class change on the 10th: charged for the class active on the 1st (3,000, not 4,000).
    const promoted = await pupil(s.school, s.section, { startedOn: '2026-04-01', endedOn: '2026-10-09' });
    await reenrol(s.school, promoted.studentId, other.section, '2026-10-10');
    // Withdrawn on the 3rd, readmitted on the 12th.
    const back = await pupil(s.school, s.section, { startedOn: '2026-04-01', endedOn: '2026-10-03' });
    await reenrol(s.school, back.studentId, s.section, '2026-10-12');
    // Left on the 3rd: the leaving month is charged in full (R181).
    const leaver = await pupil(s.school, s.section, { startedOn: '2026-04-01', endedOn: '2026-10-03' });
    // Left in September: nothing for October.
    const gone = await pupil(s.school, s.section, { startedOn: '2026-04-01', endedOn: '2026-09-20' });
    // Suspended: charged (rule 20).
    const suspended = await pupil(s.school, s.section, { startedOn: '2026-04-01', status: 'suspended' });

    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-20'));
    // The catch-up on later days changes nothing (one per student per period, R179).
    await daily(app, s.school, karachi('2026-10-21', 1));
    for (const p of [moved, back, leaver, suspended]) {
      const rows = await tuitionOf(s, p.studentId, '2026-10');
      expect(rows.map((r) => [r.enrolmentId, r.amount])).toEqual([[p.enrolmentId, 3000]]);
    }
    expect((await tuitionOf(s, promoted.studentId, '2026-10')).map((r) => [r.enrolmentId, r.amount])).toEqual([[promoted.enrolmentId, 3000]]);
    expect(await tuitionOf(s, gone.studentId, '2026-10')).toEqual([]);
    // R240: generated on the 20th, after the nominal 10th: due 7 days after creation.
    const late = (await tuitionOf(s, leaver.studentId, '2026-10'))[0];
    expect(late?.dueOn.toISOString().slice(0, 10)).toBe('2026-10-27');
  });

  it('R180, A1: admitted after the cut-off is not charged the month, on or before it is; the yearly head ignores the cut-off; the catch-up charges a child admitted after the 1st', async () => {
    const s = await setup();
    await daily(app, s.school, karachi('2026-10-01', 1));
    const on14 = await pupil(s.school, s.section, { startedOn: '2026-10-14' });
    const on16 = await pupil(s.school, s.section, { startedOn: '2026-10-16' });
    const before = await db().chargeRun.count({ where: { schoolId: s.school.id } });
    await daily(app, s.school, karachi('2026-10-17', 1));
    expect((await tuitionOf(s, on14.studentId, '2026-10')).length).toBe(1);
    expect(await tuitionOf(s, on16.studentId, '2026-10')).toEqual([]);
    const annual = await db().charge.findMany({ where: { schoolId: s.school.id, feeHeadId: s.heads.annual, studentId: { in: [on14.studentId, on16.studentId] } } });
    expect(annual.length).toBe(2);
    // The catch-up that inserted wrote a `done` run; one that finds nothing writes none.
    expect(await db().chargeRun.count({ where: { schoolId: s.school.id } })).toBe(before + 1);
    await daily(app, s.school, karachi('2026-10-18', 1));
    expect(await db().chargeRun.count({ where: { schoolId: s.school.id } })).toBe(before + 1);
    // November: the yearly head is not charged again (once per year, charges_yearly_key).
    await daily(app, s.school, karachi('2026-11-01', 1));
    expect(await db().charge.count({ where: { schoolId: s.school.id, feeHeadId: s.heads.annual } })).toBe(2);
    expect((await tuitionOf(s, on16.studentId, '2026-11')).length).toBe(1);
  });

  it('R179: a voided generated charge never returns on its own; regenerateVoided recreates it', async () => {
    const s = await setup();
    const p = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-01'));
    const [charge] = await tuitionOf(s, p.studentId, '2026-10');
    await db().charge.updateMany({
      where: { schoolId: s.school.id, id: charge?.id },
      data: { status: 'voided', voidedAt: new Date(), voidedBy: s.principal.userId, voidReason: 'Wrong amount' },
    });
    await daily(app, s.school, karachi('2026-10-02', 1));
    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-02'));
    expect((await tuitionOf(s, p.studentId, '2026-10')).map((c) => c.status)).toEqual(['voided']);
    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-02'), { regenerateVoided: true, triggeredBy: s.principal.userId });
    expect((await tuitionOf(s, p.studentId, '2026-10')).map((c) => c.status)).toEqual(['voided', 'open']);
  });

  it('G3: a voided past month regenerated after its concession ended is conceded as it was in force then', async () => {
    const s = await setup();
    const kept = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    const late = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    const concede = async (p: typeof kept, endedAt: Date | null) => {
      const concession = await db().concession.create({
        data: {
          schoolId: s.school.id, studentId: p.studentId, academicYearId: s.year.id, enrolmentId: p.enrolmentId,
          kind: 'percentage', value: 50, effectiveFrom: '2026-09', reason: 'Need-based support', requestedBy: s.principal.userId,
          status: 'approved', decidedBy: s.principal.userId, decidedAt: new Date(),
        },
      });
      await db().concessionHead.create({ data: { schoolId: s.school.id, concessionId: concession.id, feeHeadId: s.heads.tuition } });
      return { concession, endedAt };
    };
    // Kept's concession ends on 20 October (after October began); Late's ended on 30 September.
    const a = await concede(kept, karachi('2026-10-20'));
    const b = await concede(late, karachi('2026-09-30'));
    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-01'));
    for (const c of [a, b]) {
      await db().concession.updateMany({
        where: { schoolId: s.school.id, id: c.concession.id },
        data: { status: 'ended', endedAt: c.endedAt, endedBy: s.principal.userId, endReason: 'Circumstances changed' },
      });
    }
    // October is voided for both and regenerated in November.
    await db().charge.updateMany({
      where: { schoolId: s.school.id, feeHeadId: s.heads.tuition, period: '2026-10', kind: 'generated' },
      data: { status: 'voided', voidedAt: new Date(), voidedBy: s.principal.userId, voidReason: 'Wrong amount' },
    });
    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-11-02'), { regenerateVoided: true, triggeredBy: s.principal.userId });
    const live = async (p: typeof kept) => (await tuitionOf(s, p.studentId, '2026-10')).find((c) => c.status !== 'voided');
    expect([(await live(kept))?.concessionAmount, (await live(kept))?.concessionId]).toEqual([1500, a.concession.id]);
    // Late's concession had ended before October began (the test backdates ended_at; the rule reads it).
    expect([(await live(late))?.concessionAmount, (await live(late))?.concessionId]).toEqual([0, null]);
    // November, generated now, sees neither ended concession.
    await runMonth(app, s.school, s.year, '2026-11', karachi('2026-11-02'));
    expect((await tuitionOf(s, kept.studentId, '2026-11')).map((c) => c.concessionAmount)).toEqual([0]);
  });

  it('R182: percentage rounds down, fixed is capped at gross and settles at 0; the amount is stored; the SQL agrees with concessionAmount', async () => {
    const s = await setup();
    const odd = await classWithSection(s.school, s.year);
    await structure(s.school, { academicYearId: s.year.id, classId: odd.classId, feeHeadId: s.heads.tuition, amount: 2999, effectiveFrom: '2026-04' }, s.principal.userId);
    const cases: { kind: 'percentage' | 'fixed'; value: number }[] = [
      { kind: 'percentage', value: 33 },
      { kind: 'percentage', value: 1 },
      { kind: 'percentage', value: 100 },
      { kind: 'fixed', value: 1000 },
      { kind: 'fixed', value: 5000 },
    ];
    const pupils = [];
    for (const c of cases) {
      const p = await pupil(s.school, odd.section, { startedOn: '2026-04-01' });
      const concession = await db().concession.create({
        data: {
          schoolId: s.school.id, studentId: p.studentId, academicYearId: s.year.id, enrolmentId: p.enrolmentId,
          kind: c.kind, value: c.value, effectiveFrom: '2026-10', reason: 'Need-based support', requestedBy: s.principal.userId,
          status: 'approved', decidedBy: s.principal.userId, decidedAt: new Date(),
        },
      });
      await db().concessionHead.create({ data: { schoolId: s.school.id, concessionId: concession.id, feeHeadId: s.heads.tuition } });
      pupils.push({ p, c });
    }
    await runMonth(app, s.school, s.year, '2026-09', karachi('2026-10-01'));
    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-01'));
    for (const { p, c } of pupils) {
      // Not yet in force in September.
      expect((await tuitionOf(s, p.studentId, '2026-09')).map((r) => r.concessionAmount)).toEqual([0]);
      const [oct] = await tuitionOf(s, p.studentId, '2026-10');
      const expected = concessionAmount(2999, { ...c, feeHeadIds: [s.heads.tuition] }, { id: s.heads.tuition, concessionEligible: true });
      expect([oct?.grossAmount, oct?.concessionAmount, oct?.amount]).toEqual([2999, expected, 2999 - expected]);
      expect(oct?.status).toBe(2999 - expected === 0 ? 'settled' : 'open');
    }
    // 33% of 2,999 is 989.67: rounded down.
    expect(concessionAmount(2999, { kind: 'percentage', value: 33, feeHeadIds: [1n] }, { id: 1n, concessionEligible: true })).toBe(989);
  });

  it('R177, R240: a class missing a priced head is listed as skipped; a past month run late falls due after the grace', async () => {
    const s = await setup();
    const bare = await classWithSection(s.school, s.year, 'Class Bare');
    await structure(s.school, { academicYearId: s.year.id, classId: bare.classId, feeHeadId: s.heads.tuition, amount: 2500, effectiveFrom: '2026-04' }, s.principal.userId);
    await pupil(s.school, bare.section, { startedOn: '2026-04-01' });
    const p = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    const runId = await runMonth(app, s.school, s.year, '2026-09', karachi('2026-10-05'), { triggeredBy: s.principal.userId });
    const run = await db().chargeRun.findFirstOrThrow({ where: { schoolId: s.school.id, id: runId } });
    expect(run.skippedClasses).toEqual([{ classId: bare.classId.toString(), reason: 'no_structure' }]);
    const [sept] = await tuitionOf(s, p.studentId, '2026-09');
    expect(sept?.dueOn.toISOString().slice(0, 10)).toBe('2026-10-12');
    // A requested run is audited against its requester when it completes.
    const audit = await db().auditLog.findMany({ where: { schoolId: s.school.id, action: 'charge_run.completed' } });
    expect(audit.map((a) => [a.actorUserId, a.subjectId])).toEqual([[s.principal.userId, runId]]);
  });

  it('R242: a run for a closed year fails without charging', async () => {
    const s = await setup();
    await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    await db().academicYear.updateMany({ where: { schoolId: s.school.id, id: s.year.id }, data: { status: 'closed' } });
    const runId = await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-01'));
    const run = await db().chargeRun.findFirstOrThrow({ where: { schoolId: s.school.id, id: runId } });
    expect([run.status, run.errorCode]).toEqual(['failed', 'year_closed']);
    expect(await db().charge.count({ where: { schoolId: s.school.id } })).toBe(0);
    // The scheduled run skips a closed year altogether.
    await daily(app, s.school, karachi('2026-11-01', 1));
    expect(await db().charge.count({ where: { schoolId: s.school.id } })).toBe(0);
  });

  // ---------------------------------------------------------------------------- late fees

  describe('R185: late fees', () => {
    async function withLateFees(s: Awaited<ReturnType<typeof setup>>, enabledAt: string) {
      await db().schoolSettings.updateMany({
        where: { schoolId: s.school.id },
        data: { lateFeeEnabled: true, lateFeeAmount: 500, lateFeeGraceDays: 7, lateFeeEnabledAt: karachi(enabledAt) },
      });
    }

    it('one per student and period, after the grace, under the fine head, against the oldest overdue charge; never twice', async () => {
      const s = await setup();
      const p = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
      const early = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
      await runMonth(app, s.school, s.year, '2026-08', karachi('2026-08-01'));
      await runMonth(app, s.school, s.year, '2026-09', karachi('2026-09-01'));
      await withLateFees(s, '2026-08-15');
      // Sept 17: due Sept 10 + 7 days of grace is not yet past.
      expect(await lateFees(app, s.school, karachi('2026-09-17'))).toBe(0);
      expect(await lateFees(app, s.school, karachi('2026-09-18'))).toBe(2);
      // Again the same day and the next: nothing new.
      expect(await lateFees(app, s.school, karachi('2026-09-18'))).toBe(0);
      expect(await lateFees(app, s.school, karachi('2026-09-19'))).toBe(0);
      const fees = await db().charge.findMany({ where: { schoolId: s.school.id, kind: 'late_fee' }, orderBy: { id: 'asc' } });
      // August's charges fell due before late fees were enabled: only September's attract one.
      const [sept] = await tuitionOf(s, p.studentId, '2026-09');
      const pFee = fees.find((f) => f.studentId === p.studentId);
      expect([pFee?.period, pFee?.feeHeadId, pFee?.amount, pFee?.lateFeeForChargeId, pFee?.dueOn.toISOString().slice(0, 10), pFee?.createdBy]).toEqual([
        '2026-09', s.heads.fine, 500, sept?.id, '2026-09-18', null,
      ]);
      expect(fees.filter((f) => f.studentId === early.studentId).length).toBe(1);
      // Disabling stops new ones.
      await db().schoolSettings.updateMany({ where: { schoolId: s.school.id }, data: { lateFeeEnabled: false } });
      await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-01'));
      expect(await lateFees(app, s.school, karachi('2026-10-30'))).toBe(0);
    });

    it('a leaver gets none: the student is no longer on the roll', async () => {
      const s = await setup();
      const leaver = await pupil(s.school, s.section, { startedOn: '2026-04-01', endedOn: '2026-09-15' });
      await runMonth(app, s.school, s.year, '2026-09', karachi('2026-09-01'));
      await withLateFees(s, '2026-09-01');
      expect((await tuitionOf(s, leaver.studentId, '2026-09')).length).toBe(1);
      expect(await lateFees(app, s.school, karachi('2026-09-20'))).toBe(0);
    });

    it('a section change keeps the student on the roll: the fee is charged, on the current enrolment', async () => {
      const s = await setup();
      const other = await createSection(db(), s.school, { id: s.classId, academicYearId: s.year.id });
      const moved = await pupil(s.school, s.section, { startedOn: '2026-04-01', endedOn: '2026-09-11' });
      const current = await reenrol(s.school, moved.studentId, other, '2026-09-12');
      await runMonth(app, s.school, s.year, '2026-09', karachi('2026-09-01'));
      await withLateFees(s, '2026-09-01');
      const [sept] = await tuitionOf(s, moved.studentId, '2026-09');
      expect(sept?.enrolmentId).toBe(moved.enrolmentId);
      expect(await lateFees(app, s.school, karachi('2026-09-20'))).toBe(1);
      const fee = await db().charge.findFirstOrThrow({ where: { schoolId: s.school.id, kind: 'late_fee', studentId: moved.studentId } });
      expect([fee.lateFeeForChargeId, fee.enrolmentId]).toEqual([sept?.id, current]);
    });

    it('a settled charge attracts none', async () => {
      const s = await setup();
      const paid = await pupil(s.school, s.section, { startedOn: '2026-04-01' });
      await runMonth(app, s.school, s.year, '2026-09', karachi('2026-09-01'));
      await withLateFees(s, '2026-09-01');
      const [settle] = await tuitionOf(s, paid.studentId, '2026-09');
      await db().charge.create({
        data: {
          schoolId: s.school.id, enrolmentId: paid.enrolmentId, studentId: paid.studentId, academicYearId: s.year.id,
          feeHeadId: s.heads.tuition, headFrequency: 'monthly', kind: 'adjustment', period: '2026-09',
          adjustsChargeId: settle?.id, grossAmount: 3000, amount: 3000, description: 'Adjustment', dueOn: day('2026-09-10'),
          status: 'settled', settledAt: new Date(), createdBy: s.principal.userId,
        },
      });
      expect(await lateFees(app, s.school, karachi('2026-09-20'))).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------- stale sweep

  it('R252: a run queued 10 minutes or running 15 is failed stale and its campaign returns to draft', async () => {
    const s = await setup();
    const now = new Date();
    const campaign = await db().chargeCampaign.create({
      data: {
        schoolId: s.school.id, name: 'Exam fee', academicYearId: s.year.id, feeHeadId: s.heads.exam, amount: 800,
        dueOn: day('2026-12-10'), createdBy: s.principal.userId, status: 'generating',
      },
    });
    const queued = await db().chargeRun.create({
      data: { schoolId: s.school.id, academicYearId: s.year.id, period: '2026-10', kind: 'monthly', queuedAt: new Date(now.getTime() - 11 * 60_000) },
    });
    const running = await db().chargeRun.create({
      data: {
        schoolId: s.school.id, academicYearId: s.year.id, period: '2026-10', kind: 'campaign', campaignId: campaign.id,
        status: 'running', queuedAt: new Date(now.getTime() - 20 * 60_000), startedAt: new Date(now.getTime() - 16 * 60_000),
      },
    });
    const fresh = await db().chargeRun.create({
      data: { schoolId: s.school.id, academicYearId: s.year.id, period: '2026-11', kind: 'monthly', queuedAt: new Date(now.getTime() - 60_000) },
    });
    expect(await asSchool(app, s.school.id, () => generation(app).staleSweep(s.school.id, now))).toBe(2);
    const rows = await db().chargeRun.findMany({ where: { schoolId: s.school.id }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.id, r.status, r.errorCode])).toEqual([
      [queued.id, 'failed', 'stale'],
      [running.id, 'failed', 'stale'],
      [fresh.id, 'queued', null],
    ]);
    expect((await db().chargeCampaign.findFirstOrThrow({ where: { schoolId: s.school.id, id: campaign.id } })).status).toBe('draft');
    const failed = await db().auditLog.findMany({ where: { schoolId: s.school.id, action: 'charge_run.failed' }, orderBy: { id: 'asc' } });
    expect(failed.map((r) => [r.actorUserId, r.subjectId, (r.metadata as { job?: string; errorCode?: string }).job])).toEqual([
      [null, queued.id, 'outbox-sweep'],
      [null, running.id, 'outbox-sweep'],
    ]);
    // The year is unblocked: a new run for the month can be queued (charge_runs_period_key).
    await runMonth(app, s.school, s.year, '2026-10', karachi('2026-10-01'));
  });

  // ---------------------------------------------------------------------------- campaign runs

  async function campaignRunOf(s: Awaited<ReturnType<typeof setup>>): Promise<{ campaignId: bigint; runId: bigint }> {
    const campaign = await db().chargeCampaign.create({
      data: {
        schoolId: s.school.id, name: 'Trip fee', academicYearId: s.year.id, feeHeadId: s.heads.exam, amount: 600,
        dueOn: day('2026-12-10'), createdBy: s.principal.userId,
      },
    });
    await db().chargeCampaignAudience.create({ data: { schoolId: s.school.id, campaignId: campaign.id, kind: 'everyone' } });
    await db().chargeCampaign.updateMany({ where: { schoolId: s.school.id, id: campaign.id }, data: { status: 'generating' } });
    const run = await db().chargeRun.create({
      data: { schoolId: s.school.id, academicYearId: s.year.id, period: '2026-10', kind: 'campaign', campaignId: campaign.id, triggeredBy: s.principal.userId },
    });
    return { campaignId: campaign.id, runId: run.id };
  }

  it('R184, R252: a campaign run whose finish fails commits no charge and its campaign returns to draft; the job does not rethrow', async () => {
    const s = await setup();
    await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    const { campaignId, runId } = await campaignRunOf(s);
    // The stale sweep failing the run between the inserts and the finish, as finish sees it.
    const finish = jest.spyOn(app.get(ChargeRunRepository, { strict: false }), 'finish').mockResolvedValueOnce(false);
    const outcome = await asSchool(app, s.school.id, () => generation(app).run(s.school.id, runId, karachi('2026-10-06')));
    finish.mockRestore();
    expect(outcome).toBe('failed');
    expect(await db().charge.count({ where: { schoolId: s.school.id, campaignId } })).toBe(0);
    expect((await db().chargeCampaign.findFirstOrThrow({ where: { schoolId: s.school.id, id: campaignId } })).status).toBe('draft');
    const run = await db().chargeRun.findFirstOrThrow({ where: { schoolId: s.school.id, id: runId } });
    expect([run.status, run.errorCode]).toEqual(['failed', 'error']);
    const audit = await db().auditLog.findMany({ where: { schoolId: s.school.id, action: 'charge_run.failed' } });
    expect(audit.map((a) => [a.actorUserId, a.subjectId, a.metadata])).toEqual([
      [null, runId, expect.objectContaining({ job: 'charge-run', errorCode: 'error' })],
    ]);
  });

  it('R184: a campaign run that succeeds leaves the campaign generated with its charges, in one transaction', async () => {
    const s = await setup();
    await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    const { campaignId, runId } = await campaignRunOf(s);
    expect(await asSchool(app, s.school.id, () => generation(app).run(s.school.id, runId, karachi('2026-10-06')))).toBe('done');
    expect(await db().charge.count({ where: { schoolId: s.school.id, campaignId } })).toBe(1);
    const campaign = await db().chargeCampaign.findFirstOrThrow({ where: { schoolId: s.school.id, id: campaignId } });
    expect([campaign.status, campaign.generatedCount]).toEqual(['generated', 1]);
  });

  // ---------------------------------------------------------------------------- A19 system audit

  it('A19: job paths audit as the system actor (metadata.job); a null actor without a job is refused', async () => {
    const s = await setup();
    await pupil(s.school, s.section, { startedOn: '2026-04-01' });
    await daily(app, s.school, karachi('2026-09-01', 1));
    await pupil(s.school, s.section, { startedOn: '2026-09-05' });
    await daily(app, s.school, karachi('2026-09-06', 1));
    await db().schoolSettings.updateMany({
      where: { schoolId: s.school.id },
      data: { lateFeeEnabled: true, lateFeeAmount: 250, lateFeeGraceDays: 7, lateFeeEnabledAt: karachi('2026-08-20') },
    });
    expect(await lateFees(app, s.school, karachi('2026-09-20'))).toBe(2);
    const rows = await db().auditLog.findMany({ where: { schoolId: s.school.id, actorUserId: null }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.action, (r.metadata as { job?: string }).job])).toEqual([
      ['charge_run.completed', 'charge-generate'],
      ['charge_run.completed', 'charge-generate'],
      ['charge.late_fees_charged', 'late-fee-sweep'],
    ]);
    expect(rows[1]?.metadata).toMatchObject({ catchUp: true, chargesInserted: 2 });
    expect(rows[2]?.metadata).toMatchObject({ inserted: 2, amount: 500, perPeriod: { '2026-09': 2 } });
    // The CHECK still refuses an actorless row that names no job.
    await expect(
      db().auditLog.create({ data: { schoolId: s.school.id, actorUserId: null, action: 'charge.voided', subjectType: 'charge', subjectId: null, metadata: {} } }),
    ).rejects.toThrow();
  });
});
