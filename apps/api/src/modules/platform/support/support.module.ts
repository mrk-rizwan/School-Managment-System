import { Module } from '@nestjs/common';
import { SchoolContext } from '../../../common/school-context';
import { MessagingModule } from '../../../messaging/messaging.module';
import { SupportReadsRepository } from '../../../repositories/platform/support-reads.repository';
import { SupportSessionRepository } from '../../../repositories/platform/support-session.repository';
import { SchoolSupportController } from './school-support.controller';
import { SupportOpenThrottleGuard, SupportReadsThrottleGuard, SupportSessionGuard } from './support-guards';
import { SupportSessionsController, SupportViewsController } from './support.controller';
import { SupportSessionsService } from './support-sessions.service';
import { SupportViewsService } from './support-views.service';

// Phase 5 slice 45 (contracts/slice-45.md; CLAUDE.md named exception 7). Three modules over one
// folder, which alone may import the two support repositories (eslint.config.mjs):
// - SupportCoreModule: the sessions service (open, close, revoke, expiry, /me), no routes; imported
//   by the other two, by the platform auth module (logout closes) and by the jobs (expiry).
// - PlatformSupportModule: the platform routes, in PlatformModule's tree (platform document).
// - SchoolSupportModule: the school routes, imported by AppModule (school document).

@Module({
  imports: [MessagingModule],
  providers: [SupportSessionRepository, SupportSessionsService],
  exports: [SupportSessionsService],
})
export class SupportCoreModule {}

@Module({
  imports: [SupportCoreModule],
  controllers: [SupportSessionsController, SupportViewsController],
  providers: [
    SupportSessionRepository,
    SupportReadsRepository,
    SupportViewsService,
    SupportSessionGuard,
    SupportReadsThrottleGuard,
    SupportOpenThrottleGuard,
  ],
})
export class PlatformSupportModule {}

@Module({
  imports: [SupportCoreModule],
  controllers: [SchoolSupportController],
  providers: [SchoolContext],
})
export class SchoolSupportModule {}
