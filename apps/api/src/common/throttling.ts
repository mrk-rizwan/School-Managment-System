import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ENV, Env } from '../config/env';

// The storage is a provider, not built inside the throttler factory, so Nest calls its
// onModuleDestroy and the Redis connection closes with the app (tests would hang otherwise).
@Module({
  providers: [
    {
      provide: ThrottlerStorageRedisService,
      inject: [ENV],
      // One retry, then fail: a request must not hang waiting for an unreachable Redis.
      useFactory: (env: Env) =>
        new ThrottlerStorageRedisService(env.REDIS_URL, { maxRetriesPerRequest: 1 }),
    },
  ],
  exports: [ThrottlerStorageRedisService],
})
class ThrottlerStorageModule {}

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerStorageModule],
      inject: [ThrottlerStorageRedisService],
      // Global default per client IP (req.ip). It is the real client address only when the
      // production edge proxy overwrites X-Forwarded-For; see the trust proxy note in bootstrap.ts.
      // Slice 2 adds the login-specific limits.
      useFactory: (storage: ThrottlerStorageRedisService) => ({
        throttlers: [{ ttl: 60_000, limit: 300 }],
        storage,
      }),
    }),
  ],
})
export class ThrottlingModule {}
