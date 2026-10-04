// Shared by the slice-14 suites (contracts/slice-14.md): the app with fake drivers and a recording
// outbox, a school with two classes, staff in the three roles and families, and request helpers.
import request from 'supertest';
import { OutboxDispatcher, type AnnouncementSendJob } from '../../src/messaging/outbox-dispatcher';
import { AnnouncementSendJob as SendJob } from '../../src/modules/announcements/announcement-send.job';
import { asSchool, messagingApp, type Enqueued, type FakeDrivers } from '../messaging/support';
import { idemKey } from '../diary/support';
import { ORIGIN, StaffHarness, type Caller } from '../staff/support';
import { createSchool, type TestSchool } from '../support/schools';
import {
  createAcademicYear,
  createClass,
  createGuardian,
  createSection,
  createStudent,
  createTeacherAssignment,
  enrol,
  isoDay,
  linkGuardian,
  type TestClass,
  type TestGuardian,
  type TestSection,
  type TestStudent,
} from '../support/students';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  status: string;
  messageType: string;
  priority: string;
  audiences: { kind: string; targetId: string | null; targetName: string | null; roles: string[] }[];
  scheduledAt: string | null;
  expiresOn: string | null;
  hasAttachment: boolean;
  attachmentMime: string | null;
  holidayId: string | null;
  createdBy: string;
  createdByName: string;
  sentAt: string | null;
  cancelReason: string | null;
  recipientCount: number;
  sendFailedAt: string | null;
  smsSegments: number | null;
}

/** The app with fake drivers, a recording outbox and HTTP helpers (StaffHarness's). */
export class AnnouncementHarness extends StaffHarness {
  drivers!: FakeDrivers;
  enqueued: Enqueued[] = [];
  readonly sends: { schoolId: bigint; job: AnnouncementSendJob }[] = [];

  override async start(): Promise<void> {
    const started = await messagingApp({ write: (line: string) => void this.logs.push(line) });
    this.app = started.app;
    this.drivers = started.drivers;
    this.enqueued = started.enqueued;
    jest
      .spyOn(this.app.get(OutboxDispatcher, { strict: false }), 'announcementSends')
      .mockImplementation((schoolId, jobs) => {
        for (const job of jobs) this.sends.push({ schoolId, job });
        return Promise.resolve();
      });
  }

  /** POST /announcements with an Idempotency-Key (a fresh one unless given). */
  create(body: object, cookie: string, key: string = idemKey()) {
    return request(this.app.getHttpServer())
      .post('/api/v1/announcements')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', key)
      .send(body);
  }

  /** A created draft (201). */
  async draft(body: object, cookie: string): Promise<Announcement> {
    const res = await this.create(body, cookie);
    if (res.status !== 201) throw new Error(`create answered ${res.status}: ${res.text}`);
    return res.body as Announcement;
  }

  /** POST /announcements/:id/send. */
  sendNow(id: string, cookie: string) {
    return this.post(`/announcements/${id}/send`, {}, cookie);
  }

  /** The `announcement-send` job for one announcement, as the worker runs it. */
  deliver(schoolId: TestSchool['id'], id: string, now: Date = new Date()) {
    const job = this.app.get(SendJob, { strict: false });
    return asSchool(this.app, schoolId, () => job.run(schoolId, BigInt(id), now));
  }

  /**
   * Send now as the web does: the request answers `sending` and enqueues the job (§5.5); the job
   * runs; the row is read back, `sent`.
   */
  async sendAndDeliver(schoolId: TestSchool['id'], id: string, cookie: string): Promise<Announcement> {
    const res = await this.sendNow(id, cookie);
    if (res.status !== 200) throw new Error(`send answered ${res.status}: ${res.text}`);
    const answered = res.body as Announcement;
    if (answered.status !== 'sending') throw new Error(`send answered ${answered.status}, not sending`);
    if ((await this.deliver(schoolId, id)) !== 'sent') throw new Error('the send job did not send');
    return (await this.read(`/announcements/${id}`, cookie)).body as Announcement;
  }

  /** A POST under /api/v1. */
  post(path: string, body: object, cookie: string) {
    return this.send('post', `/api/v1${path}`, body, cookie);
  }

  /** A PATCH under /api/v1. */
  patch(path: string, body: object, cookie: string) {
    return this.send('patch', `/api/v1${path}`, body, cookie);
  }

  /** A GET under /api/v1. */
  read(path: string, cookie: string) {
    return this.get(`/api/v1${path}`, cookie);
  }
}

/** A minimal valid create body. */
export const announcement = (audiences: object[], extra: object = {}) => ({
  title: 'Sports day on Friday',
  body: 'Children come in sports kit.\nPick-up is at 1 pm.',
  category: 'event',
  priority: 'normal',
  audiences,
  ...extra,
});

export interface Campus {
  school: TestSchool;
  klass: TestClass;
  sectionA: TestSection;
  sectionB: TestSection;
  otherClass: TestClass;
  otherSection: TestSection;
  principal: Caller;
  office: Caller;
  teacher: Caller;
  /** Three children in section A, one guardian for all three. */
  kids: TestStudent[];
  parent: TestGuardian;
  /** A child in section B with their own guardian. */
  childB: TestStudent;
  parentB: TestGuardian;
}

/**
 * One school: Class Five (sections A and B), Class Six (one section). A principal, an office clerk
 * and a teacher who is class teacher of 5 A only. Three children in 5 A share one guardian; one
 * child in 5 B has their own. Student logins are on. Enrolments and the assignment began 30 days ago.
 */
export async function campus(h: StaffHarness, opts: { allowed?: string[] } = {}): Promise<Campus> {
  const db = h.db;
  const school = await createSchool({ name: 'Iqra Model School' });
  await db.schoolSettings.create({
    data: {
      schoolId: school.id,
      feeDueDay: 10,
      studentLoginEnabled: true,
      ...(opts.allowed === undefined ? {} : { smsAllowedTypes: opts.allowed as never[] }),
    },
  });
  const year = await createAcademicYear(db, school);
  const klass = await createClass(db, school, year, { name: 'Class Five' });
  const sectionA = await createSection(db, school, klass, { name: 'A' });
  const sectionB = await createSection(db, school, klass, { name: 'B' });
  const otherClass = await createClass(db, school, year, { name: 'Class Six' });
  const otherSection = await createSection(db, school, otherClass, { name: 'A' });
  const principal = await h.caller(school, 'principal', 'Nadia Principal');
  const office = await h.caller(school, 'office_staff', 'Omar Office');
  const teacher = await h.caller(school, 'teacher', 'Ayesha Teacher');
  const started = isoDay(-30);
  await createTeacherAssignment(db, school, teacher, { role: 'class_teacher', section: sectionA, startsOn: started });
  const parent = await createGuardian(db, school, { fullName: 'Sana Khan' });
  const kids: TestStudent[] = [];
  for (const [i, name] of ['Zara Khan', 'Ali Khan', 'Omar Khan'].entries()) {
    const kid = await createStudent(db, school, { fullName: name });
    await enrol(db, school, kid, sectionA, { startedOn: started });
    await linkGuardian(db, school, kid, parent, { isPrimaryContact: true, canLogin: i < 2 });
    kids.push(kid);
  }
  const childB = await createStudent(db, school, { fullName: 'Hira Malik' });
  await enrol(db, school, childB, sectionB, { startedOn: started });
  const parentB = await createGuardian(db, school, { fullName: 'Bilal Malik' });
  await linkGuardian(db, school, childB, parentB);
  return { school, klass, sectionA, sectionB, otherClass, otherSection, principal, office, teacher, kids, parent, childB, parentB };
}
