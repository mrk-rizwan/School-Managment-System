import { Module } from '@nestjs/common';
import { SchoolContext } from '../../common/school-context';
import { AuditLogRepository } from '../../repositories/audit-log.repository';
import { DeviceRepository } from '../../repositories/device.repository';
import { MeSessionsController } from './me-sessions.controller';
import { MeSessionsService } from './me-sessions.service';

/**
 * Phase 2 routes under /me/* (plan §4.3): devices and sessions (slice 9), then inbox, calendar,
 * and the capacity trees /me/children/* (guardian), /me/student/* (student), /me/staff/* (staff).
 * The first segment after /me/ names the capacity. GET /me and POST /me/change-password stay in
 * SchoolAuthModule.
 */
@Module({
  controllers: [MeSessionsController],
  providers: [MeSessionsService, DeviceRepository, AuditLogRepository, SchoolContext],
})
export class MeModule {}
