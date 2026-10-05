// Shared set-up for the slice-9 messaging suites: fake drivers (a real driver is never called in
// a test; driver contract tests run only under RUN_DRIVER_TESTS=1), a recording outbox (the
// "expectMessages" helper of plan §3), and seeds for schools, people, devices and numbers.
import { randomBytes } from 'node:crypto';
import { Transactional } from '@nestjs-cls/transactional';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ContactCapability, DeliveryErrorCode, MessageType } from '@asms/shared';
import type {
  HealthOutcome,
  MessagingDrivers,
  PushMessage,
  PushOutcome,
  SendOutcome,
  SmsStatus,
} from '../../src/messaging/drivers/types';
import { MESSAGING_DRIVERS } from '../../src/messaging/drivers/types';
import { OutboxDispatcher } from '../../src/messaging/outbox-dispatcher';
import { FieldCipher } from '../../src/common/crypto/field-encryption';
import type { GuardedPrismaClient } from '../../src/repositories/prisma';
import { QueueTenancy } from '../../src/tenancy/queue.mint';
import type { SchoolId } from '../../src/tenancy/school-id';
import { createTestApp, queuePrefixOf } from '../core/app';
import { createSchoolSession, createSchoolUser, type TestSchoolUser } from '../support/school-session';
import { createSchool, testDb, type TestSchool } from '../support/schools';
import { createGuardian, randomPhone } from '../support/students';
import { loadEnv } from '../../src/config/env';

export interface DriverCall {
  channel: 'push' | 'whatsapp' | 'sms' | 'email';
  to?: string;
  text?: string;
  tokens?: readonly string[];
  push?: PushMessage;
  template?: string;
  /** sendMedia only: what travelled as bytes (slice 14, R148). */
  media?: { mime: string; filename: string; size: number };
}

/** Records every call; outcomes are queued per channel (default: accepted). */
export class FakeDrivers implements MessagingDrivers {
  readonly calls: DriverCall[] = [];
  readonly whatsappOutcomes: SendOutcome[] = [];
  readonly smsOutcomes: SendOutcome[] = [];
  pushOutcome: PushOutcome | null = null;
  healthOutcome: HealthOutcome = { ok: true };
  readonly smsStatuses = new Map<string, SmsStatus>();
  wahaStart: 'working' | 'needs_qr' | 'fail' = 'needs_qr';
  cloudVerify: { ok: true; displayPhoneNumber: string } | { ok: false; reason: 'token_rejected' | 'not_found' | 'unreachable' } =
    { ok: false, reason: 'not_found' };
  readonly stopped: string[] = [];

  private ref = () => randomBytes(8).toString('hex');

  push = {
    send: (tokens: readonly string[], message: PushMessage): Promise<PushOutcome> => {
      this.calls.push({ channel: 'push', tokens, push: message });
      return Promise.resolve(this.pushOutcome ?? { accepted: tokens.length > 0, unregistered: [], error: tokens.length > 0 ? null : 'unregistered_device' });
    },
  };

  private whatsappDriver = {
    sendText: (_sender: unknown, to: string, text: string, template: string): Promise<SendOutcome> => {
      this.calls.push({ channel: 'whatsapp', to, text, template });
      return Promise.resolve(this.whatsappOutcomes.shift() ?? { kind: 'accepted', ref: `wa-${this.ref()}` });
    },
    sendMedia: (
      _sender: unknown,
      to: string,
      text: string,
      media: { bytes: Buffer; mime: string; filename: string },
      template: string,
    ): Promise<SendOutcome> => {
      this.calls.push({
        channel: 'whatsapp',
        to,
        text,
        template,
        media: { mime: media.mime, filename: media.filename, size: media.bytes.length },
      });
      return Promise.resolve(this.whatsappOutcomes.shift() ?? { kind: 'accepted', ref: `wa-${this.ref()}` });
    },
    health: (): Promise<HealthOutcome> => Promise.resolve(this.healthOutcome),
  };

  whatsapp = { waha: this.whatsappDriver, cloud_api: this.whatsappDriver };

  waha = {
    start: (): Promise<'working' | 'needs_qr'> =>
      this.wahaStart === 'fail' ? Promise.reject(new Error('down')) : Promise.resolve(this.wahaStart),
    qr: (): Promise<string> => Promise.resolve('data:image/png;base64,iVBORw0KGgo='),
    stop: (session: string): Promise<void> => {
      this.stopped.push(session);
      return Promise.resolve();
    },
  };

  cloud = { verify: () => Promise.resolve(this.cloudVerify) };

  sms = {
    pull: true,
    send: (to: string, text: string): Promise<SendOutcome> => {
      this.calls.push({ channel: 'sms', to, text });
      return Promise.resolve(this.smsOutcomes.shift() ?? { kind: 'accepted', ref: this.ref() });
    },
    fetchStatus: (ref: string): Promise<SmsStatus> => Promise.resolve(this.smsStatuses.get(ref) ?? { kind: 'pending' }),
  };

  email = {
    send: (to: string, subject: string, text: string): Promise<SendOutcome> => {
      this.calls.push({ channel: 'email', to, text, template: subject });
      return Promise.resolve({ kind: 'accepted', ref: null });
    },
  };

  of(channel: DriverCall['channel']): DriverCall[] {
    return this.calls.filter((c) => c.channel === channel);
  }

  failWhatsApp(error: DeliveryErrorCode, times = 1): void {
    for (let i = 0; i < times; i++) this.whatsappOutcomes.push({ kind: 'failed', error });
  }
}

export interface Enqueued {
  kind: 'message' | 'rollup' | 'health';
  schoolId: bigint;
  id: bigint;
  delayMs?: number;
}

/** The app with fake drivers; every enqueue is recorded instead of reaching Redis. */
export async function messagingApp(
  logStream?: { write(line: string): void },
  extra: { provide: unknown; useValue: unknown }[] = [],
): Promise<{
  app: NestExpressApplication;
  drivers: FakeDrivers;
  enqueued: Enqueued[];
}> {
  const drivers = new FakeDrivers();
  const app = await createTestApp({
    overrides: [{ provide: MESSAGING_DRIVERS, useValue: drivers }, ...extra],
    ...(logStream ? { logStream } : {}),
  });
  const enqueued: Enqueued[] = [];
  const outbox = app.get(OutboxDispatcher, { strict: false });
  // Slice 17: the methods not mocked below (and any a suite's restoreAllMocks un-mocks) enqueue
  // under createTestApp's test-only prefix, never where a worker listens; the app's close() fails
  // if anything reached a production-named queue (test/core/app.ts).
  const prefix = queuePrefixOf(app);
  if (!prefix?.startsWith('asms-test-')) throw new Error(`the messaging harness enqueues under ${prefix ?? 'the default prefix'}`);
  jest.spyOn(outbox, 'messages').mockImplementation((schoolId, jobs) => {
    for (const job of jobs) enqueued.push({ kind: 'message', schoolId, id: job.id, delayMs: job.delayMs ?? 0 });
    return Promise.resolve();
  });
  jest.spyOn(outbox, 'rollup').mockImplementation((schoolId, reports) => {
    for (const r of reports) enqueued.push({ kind: 'rollup', schoolId, id: r.messageId });
    return Promise.resolve();
  });
  jest.spyOn(outbox, 'health').mockImplementation((schoolId, id) => {
    enqueued.push({ kind: 'health', schoolId, id });
    return Promise.resolve();
  });
  // OutboxDispatcher swallows a failed enqueue (the sweep recovers it), which is how job ids
  // BullMQ refused went unnoticed. The methods not mocked above reach the real Redis; closing the
  // app fails the suite if any of their enqueues failed.
  const close = app.close.bind(app);
  app.close = async () => {
    const failures = outbox.enqueueFailures;
    await close();
    if (failures !== 0) throw new Error(`${failures} enqueue(s) failed during this suite (OutboxDispatcher.enqueueFailures)`);
  };
  return { app, drivers, enqueued };
}

/** Runs `fn` as a job would: in a fresh CLS context carrying the school. */
export function asSchool<T>(app: NestExpressApplication, schoolId: SchoolId, fn: () => Promise<T>): Promise<T> {
  return app.get(QueueTenancy, { strict: false }).runAsSchool(schoolId, fn);
}

/** A sender's transaction, as a service's @Transactional() method gives one. */
export class TxRunner {
  @Transactional()
  run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export const tx = new TxRunner();

/** A school with its settings row; `smsAllowedTypes` default is the platform default list. */
export async function messagingSchool(
  opts: { cap?: number; status?: 'active' | 'suspended' | 'trial'; allowed?: MessageType[] } = {},
): Promise<TestSchool> {
  const db = testDb();
  const school = await createSchool({ name: 'Iqra Model School', status: opts.status ?? 'active' });
  await db.schoolSettings.create({
    data: {
      schoolId: school.id,
      feeDueDay: 10,
      ...(opts.allowed === undefined ? {} : { smsAllowedTypes: opts.allowed }),
    },
  });
  if (opts.cap !== undefined) {
    await db.school.update({ where: { id: school.id }, data: { smsMonthlyCap: opts.cap } });
  }
  return school;
}

export async function connectedNumber(
  db: GuardedPrismaClient,
  school: TestSchool,
  status: 'connected' | 'down' | 'pending' = 'connected',
): Promise<bigint> {
  const by = await createSchoolUser(db, school, { systemRole: 'principal' });
  const row = await db.whatsAppNumber.create({
    data: {
      schoolId: school.id,
      phone: randomPhone(),
      provider: 'waha',
      status,
      pairedBy: by.userId,
      pairedAt: status === 'pending' ? null : new Date(),
    },
  });
  await db.whatsAppNumber.updateMany({ where: { schoolId: school.id, id: row.id }, data: { wahaSession: `asms_${row.id}` } });
  return row.id;
}

/** A guardian; with `login` a guardian user, with `device` a live bearer session and device. */
export async function guardian(
  db: GuardedPrismaClient,
  school: TestSchool,
  opts: { capability?: ContactCapability; phone?: string | null; login?: boolean; device?: boolean } = {},
): Promise<{ id: bigint; userId: bigint | null; phone: string | null; token: string | null }> {
  const g = await createGuardian(db, school, {
    contactCapability: opts.capability ?? 'whatsapp',
    ...(opts.phone === undefined ? {} : { phone: opts.phone }),
  });
  if (!opts.login && !opts.device) return { id: g.id, userId: null, phone: g.phone, token: null };
  const user = await db.user.create({
    data: {
      schoolId: school.id,
      usernameHash: randomBytes(32).toString('hex'),
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$dGVzdHNhbHQ$dGVzdC1vbmx5LW5vdC1hLWhhc2g',
      guardianId: g.id,
    },
  });
  let token: string | null = null;
  if (opts.device) token = await device(db, school, user.id);
  return { id: g.id, userId: user.id, phone: g.phone, token };
}

/** A live bearer session with a registered device for `userId`; returns the push token. */
export async function device(db: GuardedPrismaClient, school: TestSchool, userId: bigint): Promise<string> {
  const session = await createSchoolSession(db, school, { userId }, { channel: 'bearer' });
  const token = `fcm-${randomBytes(12).toString('hex')}`;
  await db.device.create({
    data: { schoolId: school.id, userId, sessionId: session.sessionId, platform: 'android', pushToken: token, appVersion: '1.0.0' },
  });
  return token;
}

export async function principal(db: GuardedPrismaClient, school: TestSchool, opts: { email?: boolean } = {}): Promise<TestSchoolUser> {
  return createSchoolUser(db, school, {
    systemRole: 'principal',
    ...(opts.email ? { email: `p${randomBytes(4).toString('hex')}@school.test`, emailVerified: true } : {}),
  });
}

/** Encrypts as the API does, for seeding a Cloud API token or a poll reference. */
export const cipher = () => new FieldCipher(loadEnv().FIELD_ENCRYPTION_KEYS);
