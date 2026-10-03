import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { MessagingModule } from '../../messaging/messaging.module';
import {
  MessagingController,
  MessagingTestThrottleGuard,
  WhatsAppConnectThrottleGuard,
  WhatsAppPairThrottleGuard,
} from './messaging.controller';

/** /api/v1/messaging (contracts/slice-9.md §5): the school's messaging settings routes. */
@Module({
  imports: [MessagingModule],
  controllers: [MessagingController],
  providers: [
    SchoolContext,
    MessagingTestThrottleGuard,
    WhatsAppPairThrottleGuard,
    WhatsAppConnectThrottleGuard,
  ],
})
export class MessagingRoutesModule {}
