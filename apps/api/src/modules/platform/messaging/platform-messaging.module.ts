import { Module } from '@nestjs/common';
import { DeliveryHealthRepository } from '../../../repositories/platform/delivery-health.repository';
import { DeliveryHealthController } from './delivery-health.controller';
import { DeliveryHealthService } from './delivery-health.service';

/** /api/v1/platform/messaging (contracts/slice-9.md §6.3). */
@Module({
  controllers: [DeliveryHealthController],
  providers: [DeliveryHealthService, DeliveryHealthRepository],
})
export class PlatformMessagingModule {}
