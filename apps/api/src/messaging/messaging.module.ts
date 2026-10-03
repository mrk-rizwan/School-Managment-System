import { Module } from '@nestjs/common';

/**
 * Messaging (Phase 2 slice 9, plan §4.2, contracts/slice-9.md §7): NotificationService, message
 * routing, templates, the outbox dispatcher and the drivers under ./drivers. Nothing reaches a
 * parent except through NotificationService (plan rule 0.11): src/messaging/drivers/** is
 * importable only from src/messaging/**, and bullmq only from src/jobs/** and
 * src/messaging/outbox-dispatcher.ts (eslint.config.mjs). Empty until slice 9.
 */
@Module({})
export class MessagingModule {}
