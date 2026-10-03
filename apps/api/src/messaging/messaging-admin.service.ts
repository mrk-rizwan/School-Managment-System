import { Inject, Injectable, Logger } from '@nestjs/common';
import { Transactional } from '@nestjs-cls/transactional';
import {
  ErrorCode,
  normalisePhone,
  type MessageChannel,
  type WhatsAppErrorCode,
  type WhatsAppProvider,
  type WhatsAppStatus,
} from '@asms/shared';
import { FieldEncryption } from '../common/crypto/field-encryption';
import { ApiException, fieldRefused } from '../common/errors/api-exception';
import { failureLog } from '../common/errors/failure-log';
import { recoverConstraint, summariseDatabaseError } from '../common/errors/prisma-errors';
import type { Actor } from '../common/school-context';
import { AuditLogRepository } from '../repositories/audit-log.repository';
import { MessageRecipientRepository } from '../repositories/message-recipient.repository';
import { MessageUsageRepository } from '../repositories/message-usage.repository';
import { SchoolMessagingRepository, type SchoolMessagingSettings } from '../repositories/school-messaging.repository';
import {
  WHATSAPP_CLOUD_ID_UNIQUE,
  WHATSAPP_LIVE_UNIQUE,
  WhatsAppNumberRepository,
  type WhatsAppNumberRecord,
} from '../repositories/whatsapp-number.repository';
import { AfterCommit } from '../tenancy/after-commit';
import { MESSAGING_DRIVERS, type MessagingDrivers } from './drivers/types';
import { yearMonthIn } from '../common/school-clock';
import { cloudTokenAad } from './provider-refs';
import { NotificationService, type TestChannel } from './notification.service';
import { OutboxDispatcher } from './outbox-dispatcher';
import { maskPhone } from './templates';

// The school's messaging settings routes (contracts/slice-9.md §5): the test message, usage, and
// the WhatsApp number's onboarding (WAHA QR pairing, Cloud API connect) and disable. Provider
// calls run outside any transaction, after commit or before the write (§5.4, §5.5).

export interface WhatsAppNumberView {
  id: bigint;
  provider: WhatsAppProvider;
  phoneMasked: string;
  status: WhatsAppStatus;
  lastHealthyAt: Date | null;
  lastErrorCode: WhatsAppErrorCode | null;
  inboundIgnoredCount: number;
  pairedAt: Date | null;
  createdAt: Date;
}

export interface WhatsAppSettingsView {
  effectiveProvider: WhatsAppProvider;
  number: WhatsAppNumberView | null;
}

export interface UsageView {
  months: { yearMonth: string; byChannel: { channel: MessageChannel; count: number }[] }[];
  cap: number;
  remaining: number;
}

/** The channels the usage view lists, zeros included (§2.2). */
const USAGE_CHANNELS = ['sms', 'whatsapp', 'push', 'email'] as const;
/** A pairing QR is valid for this long; the screen re-requests on expiry (§5.4). */
export const QR_TTL_MS = 45_000;

const conflict = (code: ErrorCode, message: string, details: Record<string, unknown> | null = null) =>
  new ApiException(409, code, message, details);
const unavailable = () =>
  new ApiException(503, ErrorCode.SERVICE_UNAVAILABLE, 'The WhatsApp service is unavailable. Try again shortly.');
const mismatch = (provider: WhatsAppProvider) =>
  conflict(
    ErrorCode.WHATSAPP_PROVIDER_MISMATCH,
    'This school uses a different WhatsApp provider.',
    { provider },
  );
const alreadyConnected = () =>
  conflict(ErrorCode.WHATSAPP_ALREADY_CONNECTED, 'A WhatsApp number is already connected.');

export function toNumberView(row: WhatsAppNumberRecord): WhatsAppNumberView {
  return {
    id: row.id,
    provider: row.provider,
    phoneMasked: maskPhone(row.phone),
    status: row.status,
    lastHealthyAt: row.lastHealthyAt,
    lastErrorCode: row.lastErrorCode,
    inboundIgnoredCount: row.inboundIgnoredCount,
    pairedAt: row.pairedAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class MessagingAdminService {
  private readonly logger = new Logger('MessagingAdmin');

  constructor(
    @Inject(MESSAGING_DRIVERS) private readonly drivers: MessagingDrivers,
    private readonly school: SchoolMessagingRepository,
    private readonly numbers: WhatsAppNumberRepository,
    private readonly usage: MessageUsageRepository,
    private readonly people: MessageRecipientRepository,
    private readonly audit: AuditLogRepository,
    private readonly notifications: NotificationService,
    private readonly encryption: FieldEncryption,
    private readonly outbox: OutboxDispatcher,
    private readonly afterCommit: AfterCommit,
  ) {}

  private async settings(actor: Actor): Promise<SchoolMessagingSettings> {
    const settings = await this.school.find(actor.schoolId);
    if (!settings) throw new Error('school row missing for a resolved tenant');
    return settings;
  }

  // ------------------------------------------------------------------------------ §5.1 test

  /** One transaction: the audit row, then the message whose subject is that row (§5.1). */
  @Transactional()
  async sendTest(actor: Actor, channel: TestChannel, senderName?: string): Promise<{ messageId: bigint }> {
    const { schoolId, userId } = actor;
    const staffId = await this.people.staffIdOfUser(schoolId, userId);
    const [staff] = staffId === null ? [] : await this.people.staff(schoolId, [staffId]);
    if (!staff) throw new ApiException(403, ErrorCode.PERMISSION_DENIED, 'Only staff can send a test message.');
    if (channel !== 'push' && !staff.phone) {
      throw conflict(ErrorCode.CONTACT_PHONE_MISSING, 'Your staff record has no phone number.');
    }
    if (channel === 'whatsapp' && !(await this.numbers.findLive(schoolId))) {
      throw conflict(ErrorCode.WHATSAPP_NUMBER_MISSING, 'The school has no WhatsApp number.');
    }
    const settings = await this.settings(actor);
    const now = new Date();
    if (channel === 'sms') {
      const used = await this.usage.smsUsed(schoolId, yearMonthIn(settings.timezone, now));
      if (used + 1 > settings.smsMonthlyCap) {
        throw conflict(ErrorCode.SMS_CAP_EXCEEDED, "This month's SMS allowance is used up.", {
          cap: settings.smsMonthlyCap,
          used,
        });
      }
    }
    const auditId = await this.audit.recordReturningId(schoolId, {
      actorUserId: userId,
      action: 'messaging.test_sent',
      subjectType: 'user',
      subjectId: userId,
      metadata: { channel },
    });
    return this.notifications.sendTest(schoolId, {
      staffId: staff.id,
      channel,
      auditId,
      vars: { senderName: senderName ?? staff.fullName, time: now },
    });
  }

  // ------------------------------------------------------------------------------ §5.2 usage

  async usageView(actor: Actor, now: Date = new Date()): Promise<UsageView> {
    const settings = await this.settings(actor);
    const thisMonth = yearMonthIn(settings.timezone, now);
    const [y, m] = thisMonth.split('-').map(Number);
    const last = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 15));
    const lastMonth = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
    const rows = await this.usage.forMonths(actor.schoolId, [thisMonth, lastMonth]);
    const months = [thisMonth, lastMonth].map((yearMonth) => ({
      yearMonth,
      byChannel: USAGE_CHANNELS.map((channel) => ({
        channel,
        count: rows.find((r) => r.yearMonth === yearMonth && r.channel === channel)?.sentCount ?? 0,
      })),
    }));
    const used = months[0]?.byChannel.find((c) => c.channel === 'sms')?.count ?? 0;
    return { months, cap: settings.smsMonthlyCap, remaining: Math.max(settings.smsMonthlyCap - used, 0) };
  }

  // ------------------------------------------------------------------------------ §5.3

  async whatsappView(actor: Actor): Promise<WhatsAppSettingsView> {
    const settings = await this.settings(actor);
    const live = await this.numbers.findLive(actor.schoolId);
    return { effectiveProvider: settings.effectiveWhatsappProvider, number: live ? toNumberView(live) : null };
  }

  // ------------------------------------------------------------------------------ §5.4 pair

  async pair(actor: Actor, phone: string | undefined): Promise<{ qr: string; expiresAt: Date }> {
    const row = await recoverConstraint(
      WHATSAPP_LIVE_UNIQUE,
      () => this.startPairing(actor, phone),
      async (error) => {
        // A concurrent first pairing won the live-row insert: answer from the table.
        const live = await this.numbers.findLive(actor.schoolId);
        if (live?.status === 'connected') throw alreadyConnected();
        if (live?.provider === 'cloud_api') throw mismatch('cloud_api');
        if (!live) throw error;
        return live;
      },
    );
    const session = row.wahaSession;
    if (session === null) throw new Error('a WAHA row without its session name');
    let started: 'working' | 'needs_qr';
    let qr: string;
    try {
      started = await this.drivers.waha.start(session);
      if (started === 'working') {
        await this.outbox.health(actor.schoolId, row.id, new Date());
        throw alreadyConnected();
      }
      qr = await this.drivers.waha.qr(session);
    } catch (error) {
      if (error instanceof ApiException) throw error;
      this.logger.warn(failureLog(error), 'WAHA pairing call failed');
      throw unavailable();
    }
    return { qr, expiresAt: new Date(Date.now() + QR_TTL_MS) };
  }

  @Transactional()
  private async startPairing(actor: Actor, phone: string | undefined): Promise<WhatsAppNumberRecord> {
    const settings = await this.settings(actor);
    if (settings.effectiveWhatsappProvider !== 'waha') throw mismatch(settings.effectiveWhatsappProvider);
    const live = await this.numbers.lockLive(actor.schoolId);
    let row: WhatsAppNumberRecord;
    let firstPairing = false;
    if (!live) {
      if (phone === undefined) {
        throw conflict(ErrorCode.WHATSAPP_NUMBER_MISSING, 'Enter the school WhatsApp number to pair it.');
      }
      row = await this.numbers.createWaha(actor.schoolId, { phone, pairedBy: actor.userId });
      firstPairing = true;
    } else if (live.provider === 'cloud_api') {
      throw mismatch('cloud_api');
    } else if (live.status === 'connected') {
      throw alreadyConnected();
    } else {
      if (phone !== undefined && phone !== live.phone) {
        throw fieldRefused('phone', ErrorCode.INVALID_VALUE, 'Disable the current number first to pair another.');
      }
      await this.numbers.restartPairing(actor.schoolId, live.id, actor.userId);
      row = { ...live, status: 'pending' };
    }
    await this.audit.record(actor.schoolId, {
      actorUserId: actor.userId,
      action: 'whatsapp.pairing_started',
      subjectType: 'whatsapp_number',
      subjectId: row.id,
      metadata: { whatsappNumberId: row.id.toString(), firstPairing },
    });
    return row;
  }

  // ------------------------------------------------------------------------------ §5.5 Cloud API

  async connectCloudApi(
    actor: Actor,
    input: { phone: string; phoneNumberId: string; accessToken: string },
  ): Promise<WhatsAppSettingsView> {
    await this.checkCloudConnect(actor, input.phoneNumberId);
    const verified = await this.drivers.cloud.verify(input.phoneNumberId, input.accessToken);
    if (!verified.ok) {
      if (verified.reason === 'unreachable') throw unavailable();
      throw conflict(ErrorCode.WHATSAPP_VERIFICATION_FAILED, 'Meta did not accept these details.', {
        reason: verified.reason,
      });
    }
    if (normalisePhone(verified.displayPhoneNumber) !== input.phone) {
      throw conflict(ErrorCode.WHATSAPP_VERIFICATION_FAILED, 'The number does not match the phone-number id.', {
        reason: 'number_mismatch',
      });
    }
    try {
      await this.writeCloudConnect(actor, input);
    } catch (error) {
      const constraint = summariseDatabaseError(error)?.constraint;
      if (constraint === WHATSAPP_CLOUD_ID_UNIQUE) {
        throw conflict(ErrorCode.WHATSAPP_VERIFICATION_FAILED, 'This number is connected to another school.', {
          reason: 'number_in_use',
        });
      }
      if (constraint === WHATSAPP_LIVE_UNIQUE) throw alreadyConnected();
      throw error;
    }
    return this.whatsappView(actor);
  }

  /** The §5.5 refusals, against the live row as it is now (re-run under the lock at write). */
  private async checkCloudConnect(actor: Actor, phoneNumberId: string, live?: WhatsAppNumberRecord | null): Promise<'insert' | 'reconnect'> {
    const settings = await this.settings(actor);
    if (settings.effectiveWhatsappProvider !== 'cloud_api') throw mismatch(settings.effectiveWhatsappProvider);
    const row = live === undefined ? await this.numbers.findLive(actor.schoolId) : live;
    if (!row) return 'insert';
    if (row.provider === 'waha') throw mismatch('waha');
    if (row.status === 'connected' || row.cloudPhoneNumberId !== phoneNumberId) throw alreadyConnected();
    return 'reconnect';
  }

  @Transactional()
  private async writeCloudConnect(
    actor: Actor,
    input: { phone: string; phoneNumberId: string; accessToken: string },
  ): Promise<void> {
    const live = await this.numbers.lockLive(actor.schoolId);
    const mode = await this.checkCloudConnect(actor, input.phoneNumberId, live);
    const now = new Date();
    const token = this.encryption.encrypt(input.accessToken, cloudTokenAad(actor.schoolId));
    let id: bigint;
    if (mode === 'insert' || !live) {
      const row = await this.numbers.createCloud(actor.schoolId, {
        phone: input.phone,
        phoneNumberId: input.phoneNumberId,
        accessToken: token,
        pairedBy: actor.userId,
        now,
      });
      id = row.id;
    } else {
      await this.numbers.reconnectCloud(actor.schoolId, live.id, {
        accessToken: token,
        pairedBy: actor.userId,
        pairedAt: live.pairedAt,
        now,
      });
      id = live.id;
    }
    await this.audit.record(actor.schoolId, {
      actorUserId: actor.userId,
      action: 'whatsapp.cloud_api_connected',
      subjectType: 'whatsapp_number',
      subjectId: id,
      metadata: { whatsappNumberId: id.toString(), reconnected: mode === 'reconnect' },
    });
  }

  // ------------------------------------------------------------------------------ §5.6 disable

  @Transactional()
  async disable(actor: Actor, reason: string): Promise<WhatsAppSettingsView> {
    const settings = await this.settings(actor);
    const live = await this.numbers.lockLive(actor.schoolId);
    if (live) {
      await this.numbers.disable(actor.schoolId, live.id, { by: actor.userId, reason, now: new Date() });
      await this.audit.record(actor.schoolId, {
        actorUserId: actor.userId,
        action: 'whatsapp.disabled',
        subjectType: 'whatsapp_number',
        subjectId: live.id,
        reason,
        metadata: { whatsappNumberId: live.id.toString(), provider: live.provider, fromStatus: live.status },
      });
      const session = live.wahaSession;
      if (live.provider === 'waha' && session !== null) {
        // Best effort, after commit: the number is already out of use.
        this.afterCommit.register(async () => {
          try {
            await this.drivers.waha.stop(session);
          } catch (error) {
            this.logger.warn(failureLog(error), 'WAHA session stop failed after disable');
          }
        });
      }
    }
    return { effectiveProvider: settings.effectiveWhatsappProvider, number: null };
  }
}
