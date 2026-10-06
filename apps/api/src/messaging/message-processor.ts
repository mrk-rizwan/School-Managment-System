import { Inject, Injectable, Logger } from '@nestjs/common';
import { buffer } from 'node:stream/consumers';
import { Transactional } from '@nestjs-cls/transactional';
import type { DeliveryErrorCode, MessageChannel, MessageType, SuppressionReason } from '@asms/shared';
import { FieldEncryption } from '../common/crypto/field-encryption';
import { failureLog } from '../common/errors/failure-log';
import { recoverConstraint } from '../common/errors/prisma-errors';
import { ObjectStorage } from '../common/storage/object-storage';
import { nextMonthStart, yearMonthIn } from '../common/school-clock';
import { DeviceRepository } from '../repositories/device.repository';
import {
  DELIVERY_ATTEMPT_UNIQUE,
  MessageDeliveryRepository,
  type DeliveryRecord,
  type NewDelivery,
} from '../repositories/message-delivery.repository';
import { MessageRecipientRepository } from '../repositories/message-recipient.repository';
import { MessageUsageRepository } from '../repositories/message-usage.repository';
import { MessageRepository, personOf, type MessageRecord } from '../repositories/message.repository';
import {
  SchoolMessagingRepository,
  type SchoolMessagingSettings,
} from '../repositories/school-messaging.repository';
import { WhatsAppNumberRepository, type WhatsAppNumberRecord } from '../repositories/whatsapp-number.repository';
import type { SchoolId } from '../tenancy/school-id';
import { ContactResolver, recipientKey, type Contact } from './contacts';
import {
  MESSAGING_DRIVERS,
  type MediaFile,
  type MessagingDrivers,
  type SendOutcome,
  type WhatsAppSender,
} from './drivers/types';
import { MediaCache } from './media-cache';
import { isExternal, legState, type ExternalChannel, type LegState } from './legs';
import { NotificationService, PK_MOBILE } from './notification.service';
import { OutboxDispatcher } from './outbox-dispatcher';
import { cloudTokenAad, pollRefAad, providerRefHash } from './provider-refs';
import { isAfterFailureSms } from './routing';
import { maskPhone, smsSegments, smsTextOf, titleOf } from './templates';

/** The stored object's type, from its key's extension (`{school_id}/{ULID}.{jpg|png|pdf}`). */
const MEDIA_MIMES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  pdf: 'application/pdf',
};

/** The push title and email subject: the message's own (announcements), else the type's. */
const titleFor = (message: MessageRecord, schoolName: string): string =>
  message.title ?? titleOf(message.type, message.subjectType, schoolName);

/**
 * R238 (phase-3-financial.md §3.6): a money message to a family is pushed with its title as the
 * body ("Fees charged"), so an amount never shows on a lock screen; WhatsApp and SMS keep it and
 * the app reads it.
 */
const TITLE_ONLY_PUSH: ReadonlySet<MessageType> = new Set<MessageType>([
  'fee_charged',
  'fee_due_reminder',
  'fee_overdue',
  'receipt_issued',
  'payment_claim_rejected',
]);

/** The person as the processor needs them at attempt time (the current phone, not a stored one). */
type AttemptContact = Pick<Contact, 'userId' | 'userHasStaff' | 'phone' | 'email'>;

/** A recipient no longer readable in this school: every leg fails as unreachable. */
const NOBODY: AttemptContact = { userId: null, userHasStaff: false, phone: null, email: null };

type Attempt =
  | { kind: 'row'; row: Omit<NewDelivery, 'messageId' | 'attempt'> }
  | { kind: 'paced'; retryAt: Date };

interface Round {
  schoolId: SchoolId;
  message: MessageRecord;
  settings: SchoolMessagingSettings;
  contact: AttemptContact;
  now: Date;
}

/**
 * The `message` job's body (contracts/slice-9.md §7.6): claim, attempt every due leg outside any
 * transaction, write each attempt's delivery row right after, then either release the message to
 * `queued` with a delayed job or roll it up to its terminal status. At-least-once: a crash between
 * a provider's acceptance and the row write can repeat that attempt after recovery.
 */
@Injectable()
export class MessageProcessor {
  private readonly logger = new Logger('MessageProcessor');
  /** One storage read per attachment per fan-out, not per recipient (media-cache.ts). */
  readonly #media = new MediaCache();

  constructor(
    @Inject(MESSAGING_DRIVERS) private readonly drivers: MessagingDrivers,
    private readonly messages: MessageRepository,
    private readonly deliveries: MessageDeliveryRepository,
    private readonly usage: MessageUsageRepository,
    private readonly numbers: WhatsAppNumberRepository,
    private readonly people: MessageRecipientRepository,
    private readonly contacts: ContactResolver,
    private readonly school: SchoolMessagingRepository,
    private readonly devices: DeviceRepository,
    private readonly encryption: FieldEncryption,
    private readonly outbox: OutboxDispatcher,
    private readonly notifications: NotificationService,
    private readonly storage: ObjectStorage,
  ) {}

  /** One round. Returns what happened, for tests and the job log. */
  async run(
    schoolId: SchoolId,
    messageId: bigint,
    now: Date = new Date(),
  ): Promise<'skipped' | 'released' | 'finished'> {
    // Read before the claim: a failure here leaves the row `queued` for the next job or the
    // sweep, instead of `sending` until the 10-minute stale-claim recovery.
    const settings = await this.school.find(schoolId);
    if (!settings) throw new Error('school row missing for a resolved tenant');
    const message = await this.messages.claim(schoolId, messageId, now);
    if (!message) return 'skipped';
    const round: Round = {
      schoolId,
      message,
      settings,
      contact: await this.contact(schoolId, message, settings.studentLoginEnabled),
      now,
    };
    const rows = await this.deliveries.listForMessage(schoolId, messageId);
    const plan = message.channelPlan;
    let wait: Date | null = null;
    let wroteRow = false;

    for (let index = 0; index < plan.length; index++) {
      const channel = plan[index];
      if (channel === undefined || !isExternal(channel)) continue;
      const state = legState(channel, rows);
      if (state.finished) continue;
      const afterFailure = isAfterFailureSms(message.priority, plan, index);
      if (afterFailure) {
        const whatsapp = legState('whatsapp', rows);
        // Waits for the WhatsApp leg; not needed while WhatsApp has reached the provider.
        if (!whatsapp.finished || whatsapp.succeeded) continue;
      }
      if (state.dueAt && state.dueAt > now) {
        wait = earliest(wait, state.dueAt);
        continue;
      }
      const attempt = await this.attempt(round, channel);
      if (attempt.kind === 'paced') {
        wait = earliest(wait, attempt.retryAt);
        continue;
      }
      const written = await this.writeAttempt(round, channel, state, attempt.row);
      if (written) {
        rows.push(written);
        wroteRow = true;
      }
      const after = legState(channel, rows);
      if (!after.finished && after.dueAt) wait = earliest(wait, after.dueAt);
    }

    const pending = this.unfinished(message, rows);
    if (pending) {
      await this.messages.release(schoolId, messageId);
      const due = wait ?? new Date(now.getTime() + 60_000);
      const round = rows.length;
      await this.outbox.messages(schoolId, [
        {
          id: messageId,
          round,
          delayMs: due.getTime() - now.getTime(),
          // A round that wrote nothing would reuse the running job's id (queues.ts).
          ...(wroteRow ? {} : { waitMinute: Math.floor(due.getTime() / 60_000) }),
        },
      ]);
      return 'released';
    }
    const { status, reason } = rollUp(rows);
    await this.messages.finish(schoolId, messageId, status, reason, now);
    return 'finished';
  }

  /** Whether any leg is still due or retrying (a sms* leg waits only on an unfinished WhatsApp). */
  private unfinished(message: MessageRecord, rows: readonly DeliveryRecord[]): boolean {
    const plan = message.channelPlan;
    return plan.some((channel, index) => {
      if (!isExternal(channel)) return false;
      if (legState(channel, rows).finished) return false;
      if (isAfterFailureSms(message.priority, plan, index)) {
        const whatsapp = legState('whatsapp', rows);
        if (whatsapp.succeeded) return false;
        return true;
      }
      return true;
    });
  }

  /** The same resolution as at write time (ContactResolver), read again now. */
  private async contact(
    schoolId: SchoolId,
    message: MessageRecord,
    studentLoginEnabled: boolean,
  ): Promise<AttemptContact> {
    const recipient = personOf(message);
    const found = await this.contacts.resolve(schoolId, [recipient], studentLoginEnabled);
    return found.get(recipientKey(recipient)) ?? NOBODY;
  }

  private async attempt(round: Round, channel: ExternalChannel): Promise<Attempt> {
    try {
      switch (channel) {
        case 'push':
          return await this.push(round);
        case 'whatsapp':
          return await this.whatsapp(round);
        case 'sms':
          return await this.sms(round);
        case 'email':
          return await this.email(round);
      }
    } catch (error) {
      this.logger.warn({ ...failureLog(error), channel }, 'attempt failed unexpectedly');
      return failed('provider_unavailable');
    }
  }

  private async push({ schoolId, message, contact, settings, now }: Round): Promise<Attempt> {
    if (contact.userId === null) return failed('unregistered_device');
    const devices = await this.contacts.liveDevices(schoolId, [contact], now);
    if (devices.length === 0) return failed('unregistered_device');
    const outcome = await this.drivers.push.send(
      devices.map((d) => d.pushToken),
      {
        title: titleFor(message, settings.name),
        body: TITLE_ONLY_PUSH.has(message.type) ? titleFor(message, settings.name) : message.body,
        // R173: ids only.
        data: {
          type: message.type,
          subjectType: message.subjectType,
          subjectId: message.subjectId.toString(),
          messageId: message.id.toString(),
        },
      },
    );
    if (outcome.accepted) {
      await this.usage.increment(schoolId, yearMonthIn(settings.timezone, now), 'push');
      return accepted(null, null);
    }
    if (outcome.error === 'unregistered_device') {
      // Every device of the user is ended (§7.6); a new sign-in registers again.
      await this.devices.unregisterForUser(schoolId, contact.userId, 'fcm_unregistered', now);
    }
    return failed(outcome.error ?? 'unknown');
  }

  private async whatsapp({ schoolId, message, contact, settings, now }: Round): Promise<Attempt> {
    const live = await this.numbers.findLive(schoolId);
    // A test message tries a down or pending number (§5.1); everything else needs `connected`.
    const usable = live && (live.status === 'connected' || message.type === 'messaging_test');
    if (!usable) return failed('session_down');
    if (contact.phone === null) return failed('invalid_number');
    const driver = this.drivers.whatsapp[live.provider];
    const template = `asms_${message.type}_v1`;
    // R148: an attachment travels as bytes with the body as its caption, never as a URL.
    const outcome =
      message.mediaObjectKey === null
        ? await driver.sendText(this.sender(schoolId, live), contact.phone, message.body, template)
        : await driver.sendMedia(
            this.sender(schoolId, live),
            contact.phone,
            message.body,
            await this.media(schoolId, message, message.mediaObjectKey),
            template,
          );
    if (outcome.kind === 'paced') return outcome;
    const masked = maskPhone(contact.phone);
    if (outcome.kind === 'failed') return failed(outcome.error, masked);
    await this.usage.increment(schoolId, yearMonthIn(settings.timezone, now), 'whatsapp');
    return accepted(outcome.ref === null ? null : providerRefHash('whatsapp', outcome.ref), masked);
  }

  /**
   * The attachment's bytes, read from the school's own prefix (as every stream is); a key outside
   * it throws, so the leg fails as an unexpected error and nothing is sent. Read once per fan-out
   * through the cache, after the prefix check.
   */
  private async media(schoolId: SchoolId, message: MessageRecord, key: string): Promise<MediaFile> {
    const extension = key.slice(key.lastIndexOf('.') + 1);
    const mime = MEDIA_MIMES[extension];
    if (!key.startsWith(`${schoolId}/`) || mime === undefined) {
      throw new Error('message media key outside the school prefix');
    }
    const bytes = await this.#media.get(key, async () => buffer((await this.storage.get(key)).body));
    return { bytes, mime, filename: `announcement-${message.subjectId}.${extension}` };
  }

  private sender(schoolId: SchoolId, live: WhatsAppNumberRecord): WhatsAppSender {
    return {
      wahaSession: live.wahaSession,
      cloudPhoneNumberId: live.cloudPhoneNumberId,
      cloudAccessToken:
        live.cloudAccessToken === null
          ? null
          : this.encryption.decrypt(live.cloudAccessToken, cloudTokenAad(schoolId)),
    };
  }

  private async sms(round: Round): Promise<Attempt> {
    const { schoolId, message, contact, settings, now } = round;
    const allowed =
      message.type === 'messaging_test' || settings.smsAllowedTypes.includes(message.type);
    // R109: every SMS leg checks the allow list as it stands at the attempt, so a type the school
    // has since removed is not sent (an urgent leg planned at write time included); a test
    // bypasses it (§5.1).
    if (!allowed) return suppressed('not_allowed');
    if (contact.phone === null || !PK_MOBILE.test(contact.phone)) return failed('invalid_number');
    // R148: an attachment is "see the app" on SMS (contracts/slice-14.md §5.4).
    const text = smsTextOf(message.body, message.mediaObjectKey !== null);
    const segments = smsSegments(text);
    const yearMonth = yearMonthIn(settings.timezone, now);
    const reserved = await this.usage.reserveSms(schoolId, yearMonth, segments, settings.smsMonthlyCap);
    if (!reserved) return suppressed('cap_reached');
    const masked = maskPhone(contact.phone);
    const outcome: SendOutcome = await this.drivers.sms.send(contact.phone, text);
    if (outcome.kind === 'paced') return outcome;
    if (outcome.kind === 'failed') return { kind: 'row', row: { ...failedRow(outcome.error, masked), segments } };
    const ref = outcome.ref;
    return {
      kind: 'row',
      row: {
        ...acceptedRow(ref === null ? null : providerRefHash('sms', ref), masked),
        pollRef:
          this.drivers.sms.pull && ref !== null
            ? this.encryption.encrypt(ref, pollRefAad(schoolId))
            : null,
        segments,
      },
    };
  }

  private async email({ schoolId, message, contact, settings, now }: Round): Promise<Attempt> {
    if (contact.email === null) return failed('rejected');
    const outcome = await this.drivers.email.send(contact.email, titleFor(message, settings.name), message.body);
    if (outcome.kind !== 'accepted') return failed(outcome.kind === 'failed' ? outcome.error : 'unknown');
    await this.usage.increment(schoolId, yearMonthIn(settings.timezone, now), 'email');
    return accepted(null, null);
  }

  /**
   * The attempt's row, written right after the attempt. A `cap_reached` suppression and the
   * month's `sms_cap_reached` notice to every active principal commit together (§7.7; R107's
   * unique makes the notice once per principal per month).
   */
  private async writeAttempt(
    round: Round,
    channel: ExternalChannel,
    state: LegState,
    row: Omit<NewDelivery, 'messageId' | 'attempt'>,
  ): Promise<DeliveryRecord | null> {
    const full: NewDelivery = {
      ...row,
      attemptedAt: round.now,
      messageId: round.message.id,
      attempt: state.attempts + 1,
      channel,
    };
    return recoverConstraint(
      DELIVERY_ATTEMPT_UNIQUE,
      async (): Promise<DeliveryRecord | null> => {
        const id =
          row.suppressedReason === 'cap_reached'
            ? await this.writeCapReached(round, full)
            : await this.deliveries.insert(round.schoolId, full);
        return {
          id,
          messageId: full.messageId,
          channel,
          attempt: full.attempt,
          status: full.status,
          errorCode: full.errorCode,
          suppressedReason: full.suppressedReason,
          attemptedAt: full.attemptedAt,
          failedAt: full.status === 'failed' ? full.attemptedAt : null,
        };
      },
      // Another worker wrote this attempt (a crash replay); the next round reads it. Any other
      // failure propagates: the job fails and the stale-claim sweep returns the row to `queued`.
      (error) => {
        this.logger.warn({ ...failureLog(error), channel }, 'delivery row already written');
        return Promise.resolve(null);
      },
    );
  }

  @Transactional()
  private async writeCapReached(round: Round, row: NewDelivery): Promise<bigint> {
    const id = await this.deliveries.insert(round.schoolId, row);
    const principals = await this.people.activePrincipalStaffIds(round.schoolId);
    const yearMonth = yearMonthIn(round.settings.timezone, round.now);
    await this.notifications.send(round.schoolId, {
      type: 'sms_cap_reached',
      subject: { type: 'sms_cap', id: BigInt(yearMonth.replace('-', '')) },
      recipients: principals.map((staffId) => ({ staffId })),
      vars: {
        cap: round.settings.smsMonthlyCap,
        nextMonthStart: nextMonthStart(round.settings.timezone, round.now),
      },
    });
    return id;
  }
}

function earliest(a: Date | null, b: Date): Date {
  return a === null || b < a ? b : a;
}

function acceptedRow(hash: string | null, toMasked: string | null): Omit<NewDelivery, 'messageId' | 'attempt'> {
  return {
    channel: 'push',
    status: 'accepted',
    providerRefHash: hash,
    pollRef: null,
    toMasked,
    errorCode: null,
    suppressedReason: null,
    segments: null,
    attemptedAt: new Date(),
  };
}

function failedRow(error: DeliveryErrorCode, toMasked: string | null = null): Omit<NewDelivery, 'messageId' | 'attempt'> {
  return { ...acceptedRow(null, toMasked), status: 'failed', errorCode: error };
}

const accepted = (hash: string | null, toMasked: string | null): Attempt => ({
  kind: 'row',
  row: acceptedRow(hash, toMasked),
});
const failed = (error: DeliveryErrorCode, toMasked: string | null = null): Attempt => ({
  kind: 'row',
  row: failedRow(error, toMasked),
});
const suppressed = (reason: SuppressionReason): Attempt => ({
  kind: 'row',
  row: { ...acceptedRow(null, null), status: 'suppressed', suppressedReason: reason },
});

/**
 * The terminal roll-up (§7.6): any leg delivered -> delivered; else any accepted -> sent; else any
 * failed -> failed; else suppressed with the first suppressed leg's reason.
 */
export function rollUp(rows: readonly DeliveryRecord[]): {
  status: 'delivered' | 'sent' | 'failed' | 'suppressed';
  reason: SuppressionReason | null;
} {
  if (rows.some((r) => r.status === 'delivered')) return { status: 'delivered', reason: null };
  if (rows.some((r) => r.status === 'accepted')) return { status: 'sent', reason: null };
  if (rows.some((r) => r.status === 'failed')) return { status: 'failed', reason: null };
  const first = rows.find((r) => r.status === 'suppressed');
  return { status: 'suppressed', reason: first?.suppressedReason ?? 'no_channel' };
}

/** Channels a plan's legs may take (exported for the rollup). */
export type PlanChannel = MessageChannel;
