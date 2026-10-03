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
