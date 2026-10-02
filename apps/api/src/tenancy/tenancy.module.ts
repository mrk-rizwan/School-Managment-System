import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { DatabaseModule } from '../repositories/database.module';
import { PRISMA_CLIENT, type GuardedPrismaClient } from '../repositories/prisma';
import { RequestContextService } from './request-context';
import { SessionEstablisher } from './session-establisher';

// The request context and the ambient transaction. Repositories read `txHost.tx`, which is the
// open interactive transaction inside @Transactional() and the guarded client outside one.
// RequestContextService is the typed accessor every other module uses to read the context.
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
      plugins: [
        new ClsPluginTransactional({
          imports: [DatabaseModule],
          adapter: new TransactionalAdapterPrisma<GuardedPrismaClient>({
            prismaInjectionToken: PRISMA_CLIENT,
            // Enables nested @Transactional() via savepoints.
            sqlFlavor: 'postgresql',
          }),
        }),
      ],
    }),
  ],
  // SessionEstablisher is deliberately not exported: only session resolution, inside src/tenancy,
  // may set the request's tenant.
  providers: [RequestContextService, SessionEstablisher],
  exports: [RequestContextService],
})
export class TenancyModule {}
