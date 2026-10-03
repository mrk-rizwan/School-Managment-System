import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { FieldEncryption } from '../common/crypto/field-encryption';
import { SchoolMessagingRepository } from '../repositories/school-messaging.repository';
import {
  WhatsAppNumberRepository,
  type WhatsAppNumberRecord,
} from '../repositories/whatsapp-number.repository';
import type { SchoolId } from '../tenancy/school-id';
import { MESSAGING_DRIVERS, type MessagingDrivers } from './drivers/types';
import { cloudTokenAad } from './provider-refs';
import { renderWhatsAppSessionDown } from './templates';

export type HealthResult = 'none' | 'connected' | 'still_connected' | 'down' | 'still_down' | 'pending';

/**
 * The WhatsApp health check (contracts/slice-9.md §7.8, R112): asks the provider about the
 * school's live number and writes the transition. pending -> connected (paired_at set the first
 * time); down -> connected; connected -> down with last_error_code and ONE whatsapp_session_down
 * email to the platform alert mailbox per transition (school name and id only). Status is written
 * only here and by the school routes, never by a webhook. Worker transitions are not audited.
 */
@Injectable()
export class WhatsAppHealth {
  private readonly logger = new Logger('WhatsAppHealth');

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(MESSAGING_DRIVERS) private readonly drivers: MessagingDrivers,
    private readonly numbers: WhatsAppNumberRepository,
    private readonly school: SchoolMessagingRepository,
    private readonly encryption: FieldEncryption,
  ) {}

  /** The school's live number (the sweep), or one named row (the webhook-triggered job). */
  async check(schoolId: SchoolId, whatsappNumberId?: bigint, now: Date = new Date()): Promise<HealthResult> {
    const row =
      whatsappNumberId === undefined
        ? await this.numbers.findLive(schoolId)
        : await this.numbers.findById(schoolId, whatsappNumberId);
    if (!row || row.status === 'disabled') return 'none';
    const outcome = await this.drivers.whatsapp[row.provider].health({
      wahaSession: row.wahaSession,
      cloudPhoneNumberId: row.cloudPhoneNumberId,
      cloudAccessToken:
        row.cloudAccessToken === null
          ? null
          : this.encryption.decrypt(row.cloudAccessToken, cloudTokenAad(schoolId)),
    });
    if (outcome.ok) {
      const written = await this.numbers.recordHealth(schoolId, row.id, row.status, {
        status: 'connected',
        lastHealthyAt: now,
        lastErrorCode: null,
        ...(row.pairedAt === null ? { pairedAt: now } : {}),
      });
      if (written === 0) return 'none';
      return row.status === 'connected' ? 'still_connected' : 'connected';
    }
    if (row.status === 'pending') return 'pending';
    if (row.status === 'down') {
      await this.numbers.recordHealth(schoolId, row.id, 'down', {
        status: 'down',
        lastErrorCode: outcome.code,
      });
      return 'still_down';
    }
    const moved = await this.numbers.recordHealth(schoolId, row.id, 'connected', {
      status: 'down',
      lastErrorCode: outcome.code,
    });
    if (moved === 1) await this.alert(schoolId, row, outcome.code, now);
    return moved === 1 ? 'down' : 'none';
  }

  private async alert(
    schoolId: SchoolId,
    _row: WhatsAppNumberRecord,
    code: Parameters<typeof renderWhatsAppSessionDown>[0]['errorCode'],
    now: Date,
  ): Promise<void> {
    const to = this.env.PLATFORM_ALERT_EMAIL;
    if (to === undefined) {
      this.logger.warn({ schoolId: schoolId.toString(), code }, 'whatsapp down; no PLATFORM_ALERT_EMAIL set');
      return;
    }
    const settings = await this.school.find(schoolId);
    const mail = renderWhatsAppSessionDown({
      schoolName: settings?.name ?? 'unknown school',
      schoolId,
      at: now,
      errorCode: code,
    });
    await this.drivers.email.send(to, mail.title, mail.body);
  }
}
