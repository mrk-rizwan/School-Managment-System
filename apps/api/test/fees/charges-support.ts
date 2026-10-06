// Slice 19 fixtures: a school with its settings and seeded fee heads, structures, admitted
// students with a fee-paying guardian, and the generation job driven as the worker drives it
// (inside QueueTenancy.runAsSchool, with a chosen clock).
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ChargeGeneration } from '../../src/modules/fees/charge-generation';
import { asSchool } from '../messaging/support';
import { createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createGuardian,
  createSection,
  createStudent,
  enrol,
  linkGuardian,
  type TestAcademicYear,
  type TestSection,
} from '../support/students';

export const db = (): ReturnType<typeof testDb> => testDb();

export interface FinanceHeads {
  tuition: bigint;
  admission: bigint;
  annual: bigint;
  exam: bigint;
  fine: bigint;
}

export interface FinanceSchool {
  school: TestSchool;
  heads: FinanceHeads;
}

/** A school with settings (due day 10, cut-off 15) and the five seeded heads (R176). */
export async function financeSchool(
  settings: { feeDueDay?: number; feeCutoffDay?: number } = {},
  name = 'Iqra Model School',
): Promise<FinanceSchool> {
  const school = await createSchool({ name });
  await db().schoolSettings.create({
    data: { schoolId: school.id, feeDueDay: settings.feeDueDay ?? 10, feeCutoffDay: settings.feeCutoffDay ?? 15 },
  });
  await db().$executeRaw`SELECT asms_seed_school_finance(${school.id}::bigint)`;
  await db().schoolCounter.create({ data: { schoolId: school.id, name: 'admission_no', value: 0n } });
  const rows = await db().feeHead.findMany({ where: { schoolId: school.id }, select: { id: true, category: true } });
  const of = (category: string): bigint => {
    const row = rows.find((r) => r.category === category);
    if (!row) throw new Error(`no seeded ${category} head`);
    return row.id;
  };
  return {
    school,
    heads: { tuition: of('tuition'), admission: of('admission'), annual: of('annual'), exam: of('exam'), fine: of('fine') },
  };
}

/** The 2026-27 session: April 2026 to March 2027, active. */
export async function session2026(school: TestSchool): Promise<TestAcademicYear> {
  return createAcademicYear(db(), school, { startsOn: '2026-04-01', endsOn: '2027-03-31', status: 'active' });
}

export async function classWithSection(
  school: TestSchool,
  year: TestAcademicYear,
  name?: string,
): Promise<{ classId: bigint; section: TestSection }> {
  const klass = await createClass(db(), school, year, name === undefined ? {} : { name });
  return { classId: klass.id, section: await createSection(db(), school, klass) };
}

/** An active structure row (R177). */
export async function structure(
  school: TestSchool,
  data: { academicYearId: bigint; classId: bigint; feeHeadId: bigint; amount: number; effectiveFrom: string },
  createdBy: bigint,
): Promise<bigint> {
  const row = await db().feeStructure.create({ data: { schoolId: school.id, ...data, createdBy }, select: { id: true } });
  return row.id;
}

export interface Pupil {
  studentId: bigint;
  enrolmentId: bigint;
  guardianId: bigint;
}

/** A student enrolled from `startedOn` (to `endedOn`), with one fee-paying primary guardian. */
export async function pupil(
  school: TestSchool,
  section: TestSection,
  opts: { startedOn: string; endedOn?: string; status?: 'active' | 'suspended' | 'withdrawn'; fullName?: string; guardianId?: bigint } = {
    startedOn: '2026-04-01',
  },
): Promise<Pupil> {
  const student = await createStudent(db(), school, {
    admittedOn: opts.startedOn,
    status: opts.status ?? 'active',
    ...(opts.fullName === undefined ? {} : { fullName: opts.fullName }),
  });
  const guardianId = opts.guardianId ?? (await createGuardian(db(), school)).id;
  await linkGuardian(db(), school, student, { id: guardianId });
  const enrolment = await enrol(db(), school, student, section, {
    startedOn: opts.startedOn,
    ...(opts.endedOn === undefined ? {} : { status: 'left', endedOn: opts.endedOn }),
  });
  return { studentId: student.id, enrolmentId: enrolment.id, guardianId };
}

/** A later enrolment of the same student (a section or class change, a readmission). */
export async function reenrol(
  school: TestSchool,
  studentId: bigint,
  section: TestSection,
  startedOn: string,
): Promise<bigint> {
  return (await enrol(db(), school, { id: studentId }, section, { startedOn })).id;
}

/** 08:00 in Karachi on `isoDay`: the school's calendar day is `isoDay`. */
export const karachi = (isoDay: string, hour = 8): Date =>
  new Date(Date.parse(`${isoDay}T00:00:00.000Z`) + (hour - 5) * 3_600_000);

export const generation = (app: NestExpressApplication): ChargeGeneration =>
  app.get(ChargeGeneration, { strict: false });

/** A queued monthly run, run now by the job body (the charge-run job). */
export async function runMonth(
  app: NestExpressApplication,
  school: TestSchool,
  year: { id: bigint },
  period: string,
  now: Date,
  opts: { regenerateVoided?: boolean; triggeredBy?: bigint } = {},
): Promise<bigint> {
  const run = await db().chargeRun.create({
    data: {
      schoolId: school.id,
      academicYearId: year.id,
      period,
      kind: 'monthly',
      regenerateVoided: opts.regenerateVoided ?? false,
      triggeredBy: opts.triggeredBy ?? null,
      queuedAt: now,
    },
    select: { id: true },
  });
  await asSchool(app, school.id, () => generation(app).run(school.id, run.id, now));
  return run.id;
}

/** The daily scheduled run for one school at `now`. */
export const daily = (app: NestExpressApplication, school: TestSchool, now: Date): Promise<void> =>
  asSchool(app, school.id, () => generation(app).daily(school.id, now));

export const lateFees = (app: NestExpressApplication, school: TestSchool, now: Date): Promise<number> =>
  asSchool(app, school.id, () => generation(app).lateFees(school.id, now));

/** Every charge of the school, by id. */
export const chargesOf = (school: TestSchool) =>
  db().charge.findMany({ where: { schoolId: school.id }, orderBy: { id: 'asc' } });
