import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { CryptoModule } from '../common/crypto/crypto.module';
import { Mailer, MailModule } from '../modules/auth/mailer';
import { AuditLogRepository } from '../repositories/audit-log.repository';
import { DeviceRepository } from '../repositories/device.repository';
import { MessageDeliveryRepository } from '../repositories/message-delivery.repository';
import { MessageRecipientRepository } from '../repositories/message-recipient.repository';
import { MessageUsageRepository } from '../repositories/message-usage.repository';
import { MessageRepository } from '../repositories/message.repository';
import { SchoolMessagingRepository } from '../repositories/school-messaging.repository';
import { SchoolSettingsRepository } from '../repositories/school-settings.repository';
import { WhatsAppNumberRepository } from '../repositories/whatsapp-number.repository';
import { ContactResolver } from './contacts';
import { createMessagingDrivers } from './drivers/drivers';
import { MESSAGING_DRIVERS } from './drivers/types';
import { DeliverySweeps } from './delivery-sweeps';
import { MessageProcessor } from './message-processor';
import { MessagingAdminService } from './messaging-admin.service';
import { MessageRollup } from './message-rollup';
import { NotificationService } from './notification.service';
import { OutboxDispatcher } from './outbox-dispatcher';
import { WhatsAppHealth } from './whatsapp-health';

const REPOSITORIES = [
  AuditLogRepository,
  DeviceRepository,
  MessageRepository,
  MessageDeliveryRepository,
  MessageUsageRepository,
  MessageRecipientRepository,
  SchoolMessagingRepository,
  // SchoolMessagingRepository composes it with OwnSchoolRepository (global TenancyModule).
  SchoolSettingsRepository,
  WhatsAppNumberRepository,
];

/**
 * Messaging (Phase 2 slice 9, plan §4.2, contracts/slice-9.md §7): NotificationService, message
 * routing, templates, the outbox dispatcher, the processor and the drivers under ./drivers.
 * Nothing reaches a parent except through NotificationService (plan rule 0.11):
 * src/messaging/drivers/** is importable only from src/messaging/**, and bullmq only from
 * src/jobs/** and src/messaging/outbox-dispatcher.ts (eslint.config.mjs). The drivers are one
 * provider (MESSAGING_DRIVERS) so tests replace them with fakes; a real driver is never called
 * in a test.
 */
@Module({
  imports: [CryptoModule, MailModule],
  providers: [
    ...REPOSITORIES,
    {
      provide: MESSAGING_DRIVERS,
      inject: [ENV, Mailer],
      useFactory: (env: Env, mailer: Mailer) => createMessagingDrivers(env, mailer),
    },
    OutboxDispatcher,
    ContactResolver,
    NotificationService,
    MessageProcessor,
    MessageRollup,
    WhatsAppHealth,
    DeliverySweeps,
    MessagingAdminService,
  ],
  exports: [
    ...REPOSITORIES,
    MESSAGING_DRIVERS,
    OutboxDispatcher,
    ContactResolver,
    NotificationService,
    MessageProcessor,
    MessageRollup,
    WhatsAppHealth,
    DeliverySweeps,
    MessagingAdminService,
  ],
})
export class MessagingModule {}
