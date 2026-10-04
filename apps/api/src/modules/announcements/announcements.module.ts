import { Module } from '@nestjs/common';
import { IdempotencyKeyGuard, IdempotentRequests } from '../../common/idempotency';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AnnouncementAudienceRepository } from '../../repositories/announcement-audience.repository';
import { AnnouncementRecipientRepository } from '../../repositories/announcement-recipient.repository';
import { AnnouncementRepository } from '../../repositories/announcement.repository';
import { IdempotencyKeyRepository } from '../../repositories/idempotency-key.repository';
import { StagedUploadRepository } from '../../repositories/staged-upload.repository';
import { DocumentsModule } from '../documents/documents.module';
import { AnnouncementDispatch } from './announcement-dispatch';
import { AnnouncementSendJob } from './announcement-send.job';
import {
  AnnouncementFilesThrottleGuard,
  AnnouncementPreviewThrottleGuard,
  AnnouncementsController,
} from './announcements.controller';
import { AnnouncementsService } from './announcements.service';
import { AudienceResolver, AudienceRules } from './audiences';

/**
 * Announcements (Phase 2 slice 14, contracts/slice-14.md): compose, preview, schedule, send,
 * cancel, the delivery summary and the sender's attachment. Exports AnnouncementsService for the
 * holiday notice (CalendarModule imports this module, never the reverse), the scheduled-send job
 * for the worker, and the repositories the inbox (MeModule) reads. MessagingModule lends
 * NotificationService and the settings, usage and audit repositories; DocumentsModule the
 * attachment files. PermissionsService and SchoolClock come from the global modules.
 */
@Module({
  imports: [MessagingModule, DocumentsModule],
  controllers: [AnnouncementsController],
  providers: [
    SchoolContext,
    IdempotencyKeyGuard,
    IdempotentRequests,
    AnnouncementPreviewThrottleGuard,
    AnnouncementFilesThrottleGuard,
    AnnouncementsService,
    AnnouncementDispatch,
    AnnouncementSendJob,
    AudienceRules,
    AudienceResolver,
    AnnouncementRepository,
    AnnouncementAudienceRepository,
    AnnouncementRecipientRepository,
    IdempotencyKeyRepository,
    StagedUploadRepository,
  ],
  exports: [AnnouncementsService, AnnouncementSendJob, AnnouncementRecipientRepository],
})
export class AnnouncementsModule {}
