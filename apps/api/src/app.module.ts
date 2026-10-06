import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
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
import { RolesModule } from './modules/access/roles.module';
import { StaffModule } from './modules/people/staff/staff.module';
import { StudentsModule } from './modules/people/students/students.module';
import { AdmissionsModule } from './modules/people/admissions/admissions.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { MeModule } from './modules/me/me.module';
import { StaffAttendanceModule } from './modules/staff-attendance/staff-attendance.module';
import { DiaryModule } from './modules/diary/diary.module';
import { FeesModule } from './modules/fees/fees.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { LeaveModule } from './modules/leave/leave.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { AnnouncementsModule } from './modules/announcements/announcements.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { JobsModule } from './jobs/jobs.module';
import { MessagingModule } from './messaging/messaging.module';
import { MessagingRoutesModule } from './modules/messaging/messaging-routes.module';
import { WebhooksModule } from './webhooks/webhooks.module';
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
    DatabaseModule,
    TenancyModule,
    HealthModule,
    PlatformModule,
    SchoolAuthModule,
    AcademicsModule,
    GuardiansModule,
    StaffModule,
    RolesModule,
    StudentsModule,
    AdmissionsModule,
    DocumentsModule,
    // Phase 2 (empty until slices 9 and 10 fill them).
    MessagingModule,
    MessagingRoutesModule,
    WebhooksModule,
    // Queue consumers and repeatable jobs; started only in the worker process (ENV.WORKER).
    JobsModule,
    CalendarModule,
    MeModule,
    StaffAttendanceModule,
    DiaryModule,
    AttendanceModule,
    AnnouncementsModule,
    // Phase 3 (phase-3-financial.md §2).
    FeesModule,
    PaymentsModule,
    LeaveModule,
    ExpensesModule,
    PayrollModule,
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
