// Slice 22 fixtures: a priced school whose academic year runs around today (so "overdue", "due in
// three days" and the cash day are real dates), two families with past-due tuition, the signed-in
// roles, and the job bodies driven as the worker drives them.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { newIdempotencyKey } from '@asms/shared';
import { FeeReminders } from '../../src/modules/finance-reports/fee-reminders';
import { asSchool } from '../messaging/support';
import type { TestSchool } from '../support/schools';
import { createAcademicYear, createGuardian, isoDay, type TestAcademicYear, type TestSection } from '../support/students';
import {
  classWithSection,
  db,
  financeSchool,
  karachi,
  pupil,
  runMonth,
  structure,
  type FinanceHeads,
  type Pupil,
} from '../fees/charges-support';
import { paymentsHttp, type Payment, type Session } from '../payments/payments-support';

export interface ReportsWorld {
  school: TestSchool;
  heads: FinanceHeads;
  year: TestAcademicYear;
  classId: bigint;
  section: TestSection;
  principal: Session;
  office: Session;
  teacher: Session;
  /** The keypad family: A and B. */
  g1: bigint;
  a: Pupil;
  b: Pupil;
  /** The WhatsApp family: C. */
  g2: bigint;
  c: Pupil;
  /** `YYYY-MM` about 45 days ago, generated; its tuition (3,000 each) is overdue. */
  past: string;
}

/** `YYYY-MM` of a day `offset` days from today. */
export const monthOf = (offset: number): string => isoDay(offset).slice(0, 7);

export function reportsHttp(app: () => NestExpressApplication) {
  const h = paymentsHttp(app);

  async function world(opts: { name?: string } = {}): Promise<ReportsWorld> {
    const fs = await financeSchool({}, opts.name);
    const principal = await h.signIn(fs.school, 'principal');
    const office = await h.signIn(fs.school, 'office_staff');
    const teacher = await h.signIn(fs.school, 'teacher');
    const year = await createAcademicYear(db(), fs.school, { startsOn: `${monthOf(-200)}-01`, endsOn: isoDay(160) });
    const { classId, section } = await classWithSection(fs.school, year);
    await structure(
      fs.school,
      { academicYearId: year.id, classId, feeHeadId: fs.heads.tuition, amount: 3000, effectiveFrom: year.startsOn.slice(0, 7) },
      principal.user.userId,
    );
    const g1 = await createGuardian(db(), fs.school, { fullName: 'Tariq Mehmood', contactCapability: 'keypad' });
    const g2 = await createGuardian(db(), fs.school, { fullName: 'Nadia Khan', contactCapability: 'whatsapp' });
    const started = year.startsOn;
    const a = await pupil(fs.school, section, { startedOn: started, fullName: 'Hamza Tariq', guardianId: g1.id });
    const b = await pupil(fs.school, section, { startedOn: started, fullName: 'Hira Tariq', guardianId: g1.id });
    const c = await pupil(fs.school, section, { startedOn: started, fullName: 'Zainab Khan', guardianId: g2.id });
    const past = monthOf(-45);
    await runMonth(app(), fs.school, year, past, karachi(`${past}-01`));
    return { ...fs, year, classId, section, principal, office, teacher, g1: g1.id, a, b, g2: g2.id, c, past };
  }

  /** A counter payment by `by` (201 expected); `receivedOn` defaults to today. */
  async function pay(
    w: ReportsWorld,
    by: Session,
    body: { guardianId: bigint; studentIds: bigint[]; amount: number; method?: string; reference?: string; receivedOn?: string; advanceForStudentId?: bigint },
    academicYearId: bigint = w.year.id,
  ): Promise<Payment> {
    const res = await h.post(
      '/payments',
      {
        academicYearId: academicYearId.toString(),
        payerGuardianId: body.guardianId.toString(),
        studentIds: body.studentIds.map(String),
        amount: body.amount,
        method: body.method ?? 'cash',
        receivedOn: body.receivedOn ?? isoDay(0),
        ...(body.reference === undefined ? {} : { reference: body.reference }),
        ...(body.advanceForStudentId === undefined ? {} : { advanceForStudentId: body.advanceForStudentId.toString() }),
      },
      by,
      newIdempotencyKey(),
    );
    if (res.status !== 201) throw new Error(`payment refused ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as Payment;
  }

  /** A manual charge due on `dueOn` (today or later) for a pupil's enrolment. */
  async function manualCharge(w: ReportsWorld, p: Pupil, amount: number, dueOn: string): Promise<string> {
    const res = await h.post(
      '/charges',
      { enrolmentId: p.enrolmentId.toString(), feeHeadId: w.heads.tuition.toString(), amount, dueOn, description: 'Tuition top-up' },
      w.office,
      newIdempotencyKey(),
    );
    if (res.status !== 201) throw new Error(`charge refused ${res.status}: ${JSON.stringify(res.body)}`);
    return (res.body as { id: string }).id;
  }

  const reminders = (w: { school: TestSchool }, now: Date = new Date()) =>
    asSchool(app(), w.school.id, () => app().get(FeeReminders, { strict: false }).daily(w.school.id, now));

  return { ...h, world, pay, manualCharge, reminders };
}
