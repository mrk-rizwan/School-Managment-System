// The slice-11 e2e harness (contracts/slice-11.md): the real AppModule with fake messaging drivers,
// every enqueue recorded instead of reaching Redis (messages, alert jobs, rollup jobs), schools
// with their settings row, staff callers with cookie sessions, sections in either mode, children
// enrolled with guardians, and the school clock under test control.
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { AttendanceMode, ContactCapability } from '@asms/shared';
import { addDays, SchoolClock, todayIn } from '../../src/common/school-clock';
import type { AlertJob, RollupJob } from '../../src/messaging/outbox-dispatcher';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { atTimeOn } from '../../src/common/school-settings-reader';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { createSchool, testDb, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createSection,
  createStudent,
  enrol,
  linkGuardian,
  type TestSection,
} from '../support/students';
import { guardian, messagingApp, type Enqueued, type FakeDrivers } from '../messaging/support';
import { ORIGIN } from '../staff/support';

export const TZ = 'Asia/Karachi';

/** The school's today shifted by `offset` days, 'YYYY-MM-DD'. */
export const schoolDay = (offset = 0): string => addDays(todayIn(TZ), offset).toISOString().slice(0, 10);
export const D = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
/** The instant of `HH:MM` on a school date. */
export const at = (iso: string, time: string): Date => atTimeOn(TZ, D(iso), time);

export interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> | null };
}
export const errorOf = (res: { body: unknown }) => (res.body as ErrorBody).error;
export const fieldsOf = (res: { body: unknown }) =>
  (errorOf(res).details as { fields: { path: string; code: string }[] }).fields;

export interface Caller extends TestSchoolUser {
  cookie: string;
}

export interface Child {
  studentId: bigint;
  enrolmentId: bigint;
  guardianId: bigint;
}

export interface SchoolSettingsOptions {
  weeklyOffDays?: number[];
  periodsPerDay?: number;
  windowDays?: number;
  lateAdviceEnabled?: boolean;
  absenceAlertTime?: string;
  registerDeadlineTime?: string;
  lateCountsAs?: 'present' | 'half_day' | 'absent_after_cutoff';
  lateCutoffTime?: string | null;
  leaveCountsAs?: 'excused' | 'absent';
}

const time = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);

export class AttendanceHarness {
  app!: NestExpressApplication;
  drivers!: FakeDrivers;
  enqueued!: Enqueued[];
  readonly alertJobs: (AlertJob & { schoolId: bigint })[] = [];
  readonly rollupJobs: (RollupJob & { schoolId: bigint })[] = [];
  readonly bodies: string[] = [];
  readonly db = testDb();

  async start(): Promise<void> {
    ({ app: this.app, drivers: this.drivers, enqueued: this.enqueued } = await messagingApp());
    const outbox = this.app.get(OutboxDispatcher, { strict: false });
    jest.spyOn(outbox, 'alerts').mockImplementation((schoolId, jobs) => {
      for (const job of jobs) this.alertJobs.push({ ...job, schoolId });
      return Promise.resolve();
    });
    jest.spyOn(outbox, 'rollups').mockImplementation((schoolId, jobs) => {
      for (const job of jobs) this.rollupJobs.push({ ...job, schoolId });
      return Promise.resolve();
    });
  }

  reset(): void {
    this.alertJobs.length = 0;
    this.rollupJobs.length = 0;
    this.enqueued.length = 0;
    this.drivers.calls.length = 0;
  }

  private clockSpy: jest.SpyInstance<Date, []> | undefined;

  /** Moves the school clock to `instant` until restoreClock(). */
  clockAt(instant: Date): void {
    this.clockSpy?.mockRestore();
    // On the prototype: every SchoolClock instance (a module may provide its own) reads it.
    this.clockSpy = jest.spyOn(SchoolClock.prototype, 'now').mockReturnValue(instant);
  }

  restoreClock(): void {
    this.clockSpy?.mockRestore();
    this.clockSpy = undefined;
  }

  /** A school with its settings row. Default: no weekly-off day, so every date is a teaching day. */
  async school(opts: SchoolSettingsOptions = {}): Promise<TestSchool> {
    const school = await createSchool({ name: 'Iqra Model School' });
    await this.db.schoolSettings.create({
      data: {
        schoolId: school.id,
        feeDueDay: 10,
        studentLoginEnabled: true,
        weeklyOffDays: opts.weeklyOffDays ?? [],
        periodsPerDay: opts.periodsPerDay ?? 8,
        attendanceAmendWindowDays: opts.windowDays ?? 3,
        lateAdviceEnabled: opts.lateAdviceEnabled ?? false,
        absenceAlertTime: time(opts.absenceAlertTime ?? '09:30'),
        registerDeadlineTime: time(opts.registerDeadlineTime ?? '10:00'),
        lateCountsAs: opts.lateCountsAs ?? 'present',
        lateCutoffTime: opts.lateCutoffTime ? time(opts.lateCutoffTime) : null,
        leaveCountsAs: opts.leaveCountsAs ?? 'excused',
      },
    });
    return school;
  }

  async caller(school: TestSchool, systemRole: 'principal' | 'office_staff' | 'teacher', fullName?: string): Promise<Caller> {
    const user = await createSchoolUser(this.db, school, {
      systemRole,
      ...(fullName === undefined ? {} : { fullName }),
    });
    const { cookie } = await createSchoolSession(this.db, school, user);
    return { ...user, cookie };
  }

  /** A year covering ±180 days, a class in `mode`, and one section. */
  async section(
    school: TestSchool,
    opts: { mode?: AttendanceMode; className?: string; sectionName?: string; yearStartsOn?: string } = {},
  ): Promise<TestSection> {
    const year = await createAcademicYear(this.db, school, {
      ...(opts.yearStartsOn === undefined ? {} : { startsOn: opts.yearStartsOn }),
    });
    const klass = await createClass(this.db, school, year, {
      attendanceMode: opts.mode ?? 'daily',
      ...(opts.className === undefined ? {} : { name: opts.className }),
    });
    return createSection(this.db, school, klass, {
      ...(opts.sectionName === undefined ? {} : { name: opts.sectionName }),
    });
  }

  /** A child enrolled in `section` (from 30 days ago by default) with one primary guardian. */
  async child(
    school: TestSchool,
    section: TestSection,
    opts: {
      fullName?: string;
      rollNo?: number | null;
      startedOn?: string;
      endedOn?: string | null;
      capability?: ContactCapability;
      guardianLogin?: boolean;
      device?: boolean;
      phone?: string | null;
      canLogin?: boolean;
    } = {},
  ): Promise<Child> {
    const student = await createStudent(this.db, school, {
      admittedOn: schoolDay(-60),
      ...(opts.fullName === undefined ? {} : { fullName: opts.fullName }),
    });
    const startedOn = opts.startedOn ?? schoolDay(-30);
    const enrolment = await enrol(this.db, school, student, section, {
      rollNo: opts.rollNo ?? null,
      startedOn,
      ...(opts.endedOn === undefined
        ? {}
        : { endedOn: opts.endedOn, status: opts.endedOn === null ? 'active' : 'left' }),
    });
    const g = await guardian(this.db, school, {
      capability: opts.capability ?? 'whatsapp',
      ...(opts.guardianLogin ? { login: true } : {}),
      ...(opts.device ? { device: true } : {}),
      ...(opts.phone === undefined ? {} : { phone: opts.phone }),
    });
    await linkGuardian(this.db, school, student, g, { canLogin: opts.canLogin ?? false });
    return { studentId: student.id, enrolmentId: enrolment.id, guardianId: g.id };
  }

  private ip = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

  private keep<T extends { text: string }>(res: T): T {
    this.bodies.push(res.text);
    return res;
  }

  async get(path: string, auth: string | Record<string, string>) {
    const req = request(this.app.getHttpServer()).get(`/api/v1${path}`).set('X-Forwarded-For', this.ip());
    return this.keep(await (typeof auth === 'string' ? req.set('Cookie', auth) : req.set(auth)));
  }

  async post(path: string, body: object, auth: string | Record<string, string>) {
    const req = request(this.app.getHttpServer()).post(`/api/v1${path}`).set('X-Forwarded-For', this.ip());
    const withAuth = typeof auth === 'string' ? req.set('Cookie', auth).set('Origin', ORIGIN) : req.set(auth);
    return this.keep(await withAuth.send(body));
  }

  submit(
    cookie: string | Record<string, string>,
    section: Pick<TestSection, 'id'>,
    body: { date: string; period?: number; reason?: string; marks: object[] },
  ) {
    return this.post(`/sections/${section.id}/submit-register`, { period: 1, ...body }, cookie);
  }

}

/** One mark per child with `status` (or per-child statuses). */
export function marks(children: readonly Child[], status: string | readonly string[] = 'present'): object[] {
  return children.map((c, i) => ({
    enrolmentId: c.enrolmentId.toString(),
    status: typeof status === 'string' ? status : status[i],
  }));
}
