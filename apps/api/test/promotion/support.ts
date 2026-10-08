// Slice 35 test support (contracts/slice-35.md): a priced school whose year A runs around today
// (its terms seeded, so its result is the final sheet's) and a planned year B after it, Class 5
// (sections A and B, next class Class 6) and the final Class 10 in A, Class 6 and Class 5 in B;
// pupils, approved final sheets with their results written straight through the guarded client,
// the HTTP helpers, and PromotionRepository over the real database for the isolation probes.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type request from 'supertest';
import { Capability, newIdempotencyKey } from '@asms/shared';
import { EnvModule } from '../../src/config/env';
import { AccessModule } from '../../src/modules/access/access.module';
import { PermissionsService } from '../../src/modules/access/permissions.service';
import { PromotionRepository } from '../../src/repositories/promotion.repository';
import type { Scope } from '../../src/tenancy/scope';
import { TenancyModule } from '../../src/tenancy/tenancy.module';
import { db, financeSchool, pupil, type FinanceHeads, type Pupil } from '../fees/charges-support';
import { ORIGIN, paymentsHttp, type Session } from '../payments/payments-support';
import { createSchoolUser } from '../support/school-session';
import type { TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  isoDay,
  type TestAcademicYear,
  type TestSection,
} from '../support/students';

export interface PromotionWorld {
  school: TestSchool;
  heads: FinanceHeads;
  principal: Session;
  office: Session;
  teacher: Session;
  yearA: TestAcademicYear;
  yearB: TestAcademicYear;
  /** Class 5 of A (next class: Class 6 of B), sections A and B. */
  a5: bigint;
  a5A: TestSection;
  a5B: TestSection;
  /** Class 10 of A, final. */
  a10: bigint;
  a10A: TestSection;
  /** Class 6 and Class 5 of B, each with a section A (Class 6 also B). */
  b6: bigint;
  b6A: TestSection;
  b6B: TestSection;
  b5: bigint;
  b5A: TestSection;
}

export interface Detail {
  id: string;
  status: string;
  sectionId: string;
  targetYearId: string;
  rows: number;
  undecided: number;
  appliedAt: string | null;
  targetYearHasClasses: boolean;
  decisions: DecisionRow[];
}

export interface DecisionRow {
  id: string;
  enrolmentId: string;
  studentId: string;
  studentName: string;
  enrolmentStatus: string;
  resultId: string | null;
  resultSuperseded: boolean;
  passed: boolean | null;
  proposed: string | null;
  decision: string | null;
  reason: string | null;
  targetClassId: string | null;
  targetSectionId: string | null;
  arrearsFlag: boolean;
  decidedByName: string | null;
  appliedAt: string | null;
  skipped: boolean;
  newEnrolmentId: string | null;
  revisedAfterApply: boolean;
}

export const detailOf = (res: request.Response) => res.body as Detail;
export const rowOf = (d: Detail, p: Pupil): DecisionRow => {
  const row = d.decisions.find((r) => r.enrolmentId === p.enrolmentId.toString());
  if (!row) throw new Error(`no row for enrolment ${p.enrolmentId}`);
  return row;
};

/**
 * The world (see the header). Year A ends 160 days from today (or `yearAEndsIn` days, negative
 * for a year already over); B starts the day after.
 */
export async function promotionWorld(
  app: () => NestExpressApplication,
  opts: { yearAEndsIn?: number } = {},
): Promise<PromotionWorld> {
  const endsIn = opts.yearAEndsIn ?? 160;
  const h = paymentsHttp(app);
  const fs = await financeSchool({}, 'Iqbal Public School');
  const principal = await h.signIn(fs.school, 'principal');
  const office = await h.signIn(fs.school, 'office_staff');
  const teacher = await h.signIn(fs.school, 'teacher');
  const yearA = await createAcademicYear(db(), fs.school, { startsOn: isoDay(-200), endsOn: isoDay(endsIn), status: 'active' });
  await db().$executeRaw`SELECT asms_seed_year_results(${fs.school.id}::bigint, ${yearA.id}::bigint)`;
  const yearB = await createAcademicYear(db(), fs.school, { startsOn: isoDay(endsIn + 1), endsOn: isoDay(endsIn + 365), status: 'planned' });
  const b6 = await createClass(db(), fs.school, yearB, { name: 'Class 6' });
  const b5 = await createClass(db(), fs.school, yearB, { name: 'Class 5' });
  const a5 = await createClass(db(), fs.school, yearA, { name: 'Class 5' });
  const a10 = await createClass(db(), fs.school, yearA, { name: 'Class 10' });
  await db().class.updateMany({ where: { schoolId: fs.school.id, id: a5.id }, data: { nextClassId: b6.id } });
  await db().class.updateMany({ where: { schoolId: fs.school.id, id: a10.id }, data: { isFinal: true } });
  return {
    ...fs,
    principal,
    office,
    teacher,
    yearA,
    yearB,
    a5: a5.id,
    a5A: await createSection(db(), fs.school, a5, { name: 'A' }),
    a5B: await createSection(db(), fs.school, a5, { name: 'B' }),
    a10: a10.id,
    a10A: await createSection(db(), fs.school, a10, { name: 'A' }),
    b6: b6.id,
    b6A: await createSection(db(), fs.school, b6, { name: 'A' }),
    b6B: await createSection(db(), fs.school, b6, { name: 'B' }),
    b5: b5.id,
    b5A: await createSection(db(), fs.school, b5, { name: 'A' }),
  };
}

/** A pupil of a section of year A from its first day. */
export const student = (
  w: PromotionWorld,
  section: TestSection,
  fullName: string,
  status: 'active' | 'suspended' = 'active',
): Promise<Pupil> => pupil(w.school, section, { startedOn: w.yearA.startsOn, fullName, status });

/** A verdict: passed, failed, or nothing assessed (null). */
export type Verdict = boolean | null;

/**
 * The section's final sheet of year A, approved by a second principal (or published), with one
 * result per pupil; or, with `termId`, that term's sheet. Returns the sheet and the result ids.
 */
export async function approvedSheet(
  w: PromotionWorld,
  section: TestSection,
  results: readonly (readonly [Pupil, Verdict])[],
  opts: { termId?: bigint; publish?: boolean } = {},
): Promise<{ sheetId: bigint; resultIds: Map<bigint, bigint> }> {
  const where = { schoolId: w.school.id };
  const termId = opts.termId ?? null;
  const sheet = await db().resultSheet.create({
    data: {
      ...where,
      academicYearId: w.yearA.id,
      termId,
      classId: section.classId,
      sectionId: section.id,
      createdBy: w.principal.user.userId,
    },
  });
  const decider = (await createSchoolUser(db(), w.school, { systemRole: 'principal' })).userId;
  const submitter = termId === null ? {} : { submittedBy: w.principal.user.userId, submittedAt: new Date() };
  await db().resultSheet.updateMany({ where: { ...where, id: sheet.id }, data: { status: 'submitted', ...submitter } });
  await db().resultSheet.updateMany({
    where: { ...where, id: sheet.id },
    data: {
      status: 'approved',
      decidedBy: decider,
      decidedAt: new Date(),
      testWeight: 20,
      examWeight: 80,
      passPercent: 40,
      passRule: 'all_subjects',
      // The final sheet's snapshot carries the term weights (result_sheets_snapshot_check).
      ...(termId === null ? { termWeights: [] } : {}),
      bands: [
        { grade: 'A', minPercent: 80 },
        { grade: 'F', minPercent: 0 },
      ],
    },
  });
  if (opts.publish) {
    await db().resultSheet.updateMany({
      where: { ...where, id: sheet.id },
      data: { status: 'published', publishedBy: decider, publishedAt: new Date() },
    });
  }
  const resultIds = new Map<bigint, bigint>();
  for (const [p, passed] of results) {
    const row = await db().result.create({
      data: {
        ...where,
        sheetId: sheet.id,
        enrolmentId: p.enrolmentId,
        studentId: p.studentId,
        academicYearId: w.yearA.id,
        termId,
        ...(passed === null
          ? { totalObtained: 0, totalMax: 0, percentBp: null, grade: null, passed: null }
          : passed
            ? { totalObtained: 75, totalMax: 100, percentBp: 7500, grade: 'A', passed: true }
            : { totalObtained: 30, totalMax: 100, percentBp: 3000, grade: 'F', passed: false, failedSubjects: 1 }),
        ...(opts.publish ? { publishedAt: new Date() } : {}),
      },
    });
    resultIds.set(p.enrolmentId, row.id);
  }
  return { sheetId: sheet.id, resultIds };
}

/** Supersedes a stored result in place, as a correction's new version or a return does. */
export async function supersede(w: PromotionWorld, resultId: bigint): Promise<void> {
  await db().result.updateMany({ where: { schoolId: w.school.id, id: resultId }, data: { supersededAt: new Date() } });
}

export function promotionHttp(app: () => NestExpressApplication) {
  const h = paymentsHttp(app);
  const open = (sectionId: bigint, targetYearId: bigint, by: Session, key = newIdempotencyKey()) =>
    h.post(`/sections/${sectionId}/promotion-sheets`, { targetYearId: targetYearId.toString() }, by, key);
  const decide = (sheetId: string, decisions: object[], by: Session) =>
    h.http().patch(`/api/v1/promotion-sheets/${sheetId}`).set('Cookie', by.cookie).set('Origin', ORIGIN).send({ decisions });
  const apply = (sheetId: string, by: Session, key = newIdempotencyKey()) =>
    h.post(`/promotion-sheets/${sheetId}/apply`, {}, by, key);
  const detail = (sheetId: string, by: Session) => h.get(`/promotion-sheets/${sheetId}`, by);
  const close = (yearId: bigint, by: Session) => h.post(`/academic-years/${yearId}/close`, {}, by);
  return { ...h, open, decide, apply, detail, close };
}

/**
 * PromotionRepository over the real database with the school-wide scope a principal's
 * assessment.define gives (control 4: the tenant comes only from the SchoolId each call is given).
 */
export async function promotionRepositoryAs(
  school: TestSchool,
  principalUserId: bigint,
): Promise<{ repo: PromotionRepository; all: Scope; close: () => Promise<void> }> {
  const moduleRef = await Test.createTestingModule({
    imports: [EnvModule, TenancyModule, AccessModule],
    providers: [PromotionRepository],
  }).compile();
  await moduleRef.init();
  const permissions = moduleRef.get(PermissionsService);
  const access = await permissions.load(school.id, principalUserId);
  const all = access && (await permissions.can(school.id, access, Capability.ASSESSMENT_DEFINE));
  if (!all || all.kind !== 'all') throw new Error('expected a school-wide scope');
  return { repo: moduleRef.get(PromotionRepository), all, close: () => moduleRef.close() };
}
