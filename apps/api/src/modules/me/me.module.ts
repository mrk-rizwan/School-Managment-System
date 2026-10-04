import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { DeviceRepository } from '../../repositories/device.repository';
import { InboxRepository } from '../../repositories/inbox.repository';
import { AnnouncementsModule } from '../announcements/announcements.module';
import { DocumentsModule } from '../documents/documents.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { MeSessionsController } from './me-sessions.controller';
import { MeSessionsService } from './me-sessions.service';
import { MeReadsThrottleGuard } from './me-throttles';

/**
 * Phase 2 routes under /me/* (plan §4.3): devices and sessions (slice 9), the inbox (slice 14),
 * then calendar and the capacity trees /me/children/* (guardian), /me/student/* (student),
 * /me/staff/* (staff). The first segment after /me/ names the capacity. GET /me and
 * POST /me/change-password stay in SchoolAuthModule.
 */
@Module({
  imports: [MessagingModule, AnnouncementsModule, DocumentsModule],
  controllers: [MeSessionsController, InboxController],
  providers: [
    MeSessionsService,
    InboxService,
    InboxRepository,
    DeviceRepository,
    AuditLogRepository,
    SchoolContext,
    MeReadsThrottleGuard,
  ],
})
export class MeModule {}
