import { Module } from '@nestjs/common';

/**
 * Phase 2 routes under /me/* (plan §4.3): inbox, calendar, devices, sessions, and the capacity
 * trees /me/children/* (guardian), /me/student/* (student), /me/staff/* (staff). The first segment
 * after /me/ names the capacity. GET /me and POST /me/change-password stay in SchoolAuthModule.
 * Empty until slices 9-16.
 */
@Module({})
export class MeModule {}
