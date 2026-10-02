import { Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { createGuardedClient, PRISMA_CLIENT, type GuardedPrismaClient } from './prisma';

// Provides the guarded Prisma client under PRISMA_CLIENT. Application code does not inject it
// directly: repositories go through the TransactionHost that TenancyModule registers, so they
// join the ambient transaction. The URL comes from the validated environment (EnvModule is global).
@Module({
  providers: [
    {
      provide: PRISMA_CLIENT,
      inject: [ENV],
      useFactory: (env: Env): GuardedPrismaClient => createGuardedClient(env.DATABASE_URL),
    },
  ],
  exports: [PRISMA_CLIENT],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: GuardedPrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
