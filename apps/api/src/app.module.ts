import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard } from '@nestjs/throttler';
import { RouteAccessGuard } from './common/auth/route-access';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { LoggingModule } from './common/logging';
import { ThrottlingModule } from './common/throttling';
import { validationPipe } from './common/validation';
import { EnvModule } from './config/env';
import { HealthModule } from './modules/health/health.module';
import { AcademicsModule } from './modules/academics/academics.module';
import { SchoolAuthModule } from './modules/auth/school-auth.module';
import { GuardiansModule } from './modules/people/guardians/guardians.module';
import { StaffModule } from './modules/people/staff/staff.module';
import { StudentsModule } from './modules/people/students/students.module';
import { AdmissionsModule } from './modules/people/admissions/admissions.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { PlatformModule } from './modules/platform/platform.module';
import { DatabaseModule } from './repositories/database.module';
import { TenancyModule } from './tenancy/tenancy.module';

// Cross-cutting pieces are APP_* providers rather than app.useGlobal*() so that every
// way of building the app (main, tests, the OpenAPI script) gets them from the module.
@Module({
  imports: [
    EnvModule,
    LoggingModule,
    ThrottlingModule,
    // The scheduler, once for the app: cron jobs live in their feature modules.
    ScheduleModule.forRoot(),
    DatabaseModule,
    TenancyModule,
    HealthModule,
    PlatformModule,
    SchoolAuthModule,
    AcademicsModule,
    GuardiansModule,
    StaffModule,
    StudentsModule,
    AdmissionsModule,
    DocumentsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useValue: validationPipe },
    // Order matters: rate limiting runs before the access check.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: RouteAccessGuard },
  ],
})
export class AppModule {}
