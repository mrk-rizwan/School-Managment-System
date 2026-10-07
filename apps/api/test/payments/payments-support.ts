// Slice 20 fixtures: a priced school with a family of siblings and their September and October
// tuition generated, three signed-in roles, and the HTTP helpers the payment suites share.
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { newIdempotencyKey, type Capability, type SystemRole } from '@asms/shared';
import {
  createSchoolSession,
  createSchoolUser,
  type TestSchoolSession,
  type TestSchoolUser,
} from '../support/school-session';
import type { TestSchool } from '../support/schools';
import { createGuardian, isoDay, type TestAcademicYear, type TestSection } from '../support/students';
import {
  classWithSection,
  db,
  financeSchool,
  karachi,
  pupil,
  runMonth,
  session2026,
  structure,
  type FinanceHeads,
  type Pupil,
} from '../fees/charges-support';

export const API = '/api/v1';
export const ORIGIN = new URL(process.env.APP_URL ?? 'http://localhost:3460').origin;

export type Session = TestSchoolSession & { user: TestSchoolUser };

export interface ErrorBody {
  error: { code: string; details: (Record<string, unknown> & { fields?: { path: string; code: string }[] }) | null };
}

export interface ReceiptLine {
  studentId: string;
  chargeId: string | null;
  feeHeadName: string | null;
  period: string | null;
  amount: number;
}
export interface Receipt {
  id: string;
  receiptNo: number;
  receiptLabel: string;
  amount: number;
  lines: ReceiptLine[];
  voidedAt: string | null;
}
export interface Reversal {
  id: string;
  kind: string;
  amount: number;
  paymentId: string;
  reversesId: string | null;
  carriedToPaymentId: string | null;
  reversed: boolean;
}
export interface Payment {
  id: string;
  academicYearId: string;
  method: string;
  amount: number;
  allocatedAmount: number;
  unallocatedAmount: number;
  advanceForStudentId: string | null;
  handoverId: string | null;
  status: string;
  receipt: Receipt | null;
  reversals: Reversal[];
  students: { studentId: string; amount: number }[];
  possibleDuplicate: boolean;
  duplicateOfPaymentId: string | null;
  payerName: string;
}
export interface Handover {
  id: string;
  status: string;
  onBehalf: boolean;
  expectedAmount: number;
  paymentCount: number;
  countedAmount: number | null;
  shortfallAmount: number | null;
  surplusAmount: number | null;
  shortfallResolution: string | null;
  shortfallExpenseId: string | null;
}

export interface World {
  school: TestSchool;
  heads: FinanceHeads;
  year: TestAcademicYear;
  yearName: string;
  classId: bigint;
  section: TestSection;
  principal: Session;
  office: Session;
  teacher: Session;
  guardianId: bigint;
  /** The elder sibling (admitted first). */
  a: Pupil;
  b: Pupil;
}

export function paymentsHttp(app: () => NestExpressApplication) {
  const http = () => request(app().getHttpServer());
  const get = (path: string, s: { cookie: string }) => http().get(`${API}${path}`).set('Cookie', s.cookie);
  const post = (path: string, body: object, s: { cookie: string }, key?: string) => {
    const req = http().post(`${API}${path}`).set('Cookie', s.cookie).set('Origin', ORIGIN);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const err = (res: request.Response) => res.body as ErrorBody;

  const signIn = async (school: TestSchool, systemRole: SystemRole, staffStatus?: 'active' | 'suspended'): Promise<Session> => {
    const user = await createSchoolUser(db(), school, { systemRole, ...(staffStatus === undefined ? {} : { staffStatus }) });
    return { ...(await createSchoolSession(db(), school, user)), user };
  };

  /**
   * A class priced at tuition 3,000 a month; two siblings with one fee-paying guardian (a keypad
   * phone: the receipt goes by SMS); September and October generated (due the 10th of each).
   */
  async function world(opts: { contactCapability?: 'whatsapp' | 'smartphone_data' | 'keypad' } = {}): Promise<World> {
    const fs = await financeSchool();
    const principal = await signIn(fs.school, 'principal');
    const office = await signIn(fs.school, 'office_staff');
    const teacher = await signIn(fs.school, 'teacher');
    const year = await session2026(fs.school);
    const { classId, section } = await classWithSection(fs.school, year);
    await structure(fs.school, { academicYearId: year.id, classId, feeHeadId: fs.heads.tuition, amount: 3000, effectiveFrom: '2026-04' }, principal.user.userId);
    const guardian = await createGuardian(db(), fs.school, {
      fullName: 'Tariq Mehmood',
      contactCapability: opts.contactCapability ?? 'keypad',
    });
    const a = await pupil(fs.school, section, { startedOn: '2026-04-01', fullName: 'Hamza Tariq', guardianId: guardian.id });
    const b = await pupil(fs.school, section, { startedOn: '2026-04-01', fullName: 'Hira Tariq', guardianId: guardian.id });
    await runMonth(app(), fs.school, year, '2026-09', karachi('2026-09-01'));
    await runMonth(app(), fs.school, year, '2026-10', karachi('2026-10-01'));
    const { name: yearName } = await db().academicYear.findFirstOrThrow({ where: { schoolId: fs.school.id, id: year.id } });
    return { ...fs, year, yearName, classId, section, principal, office, teacher, guardianId: guardian.id, a, b };
  }

  /** Records a counter payment and returns it (201 expected). */
  async function pay(
    w: World,
    by: Session,
    body: { studentIds: bigint[]; amount: number; method?: string; reference?: string; advanceForStudentId?: bigint; payerName?: string },
    key = newIdempotencyKey(),
  ): Promise<Payment> {
    const res = await post(
      '/payments',
      {
        academicYearId: w.year.id.toString(),
        ...(body.payerName === undefined ? { payerGuardianId: w.guardianId.toString() } : { payerName: body.payerName }),
        studentIds: body.studentIds.map(String),
        amount: body.amount,
        method: body.method ?? 'cash',
        receivedOn: isoDay(0),
        ...(body.reference === undefined ? {} : { reference: body.reference }),
        ...(body.advanceForStudentId === undefined ? {} : { advanceForStudentId: body.advanceForStudentId.toString() }),
      },
      by,
      key,
    );
    if (res.status !== 201) throw new Error(`payment refused ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body as Payment;
  }

  const grant = (to: TestSchoolUser, by: TestSchoolUser, capability: Capability) =>
    db().userCapabilityGrant.create({
      data: { schoolId: to.schoolId, userId: to.userId, capabilityKey: capability, effect: 'grant', grantedBy: by.userId, reason: 'Test grant' },
    });

  /** Makes `user` a guardian of `child` (R232's own child). */
  const parentOf = (w: { school: TestSchool }, user: TestSchoolUser, child: Pupil) =>
    db().user.updateMany({ where: { schoolId: w.school.id, id: user.userId }, data: { guardianId: child.guardianId } });

  const charges = (w: { school: TestSchool }, studentId: bigint) =>
    db().charge.findMany({ where: { schoolId: w.school.id, studentId, kind: { not: 'adjustment' } }, orderBy: [{ dueOn: 'asc' }, { id: 'asc' }] });

  const audit = (school: TestSchool, action: string) =>
    db().auditLog.findMany({ where: { schoolId: school.id, action }, orderBy: { id: 'asc' } });

  return { http, get, post, err, signIn, world, pay, grant, parentOf, charges, audit };
}
