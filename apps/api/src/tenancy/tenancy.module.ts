import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { AccessModule } from '../modules/access/access.module';
import { DatabaseModule } from '../repositories/database.module';
import { PRISMA_CLIENT, type GuardedPrismaClient } from '../repositories/prisma';
import { OwnSchoolRepository } from '../repositories/own-school.repository';
import { SessionRepository } from '../repositories/session.repository';
import { RequestContextService } from './request-context';
import { SchoolSessionResolver } from './school-session-resolver';
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
    // Session resolution checks the user's capacities (contract slice-2 §1.1 step 3). Imported
    // here so every module tree with TenancyModule (tests included) can build the resolver.
    AccessModule,
  ],
  // SessionEstablisher is deliberately not exported: only session resolution, inside src/tenancy,
  // may set the request's tenant.
  // SchoolSessionResolver (named exception 4) is exported for the access guard; it is the only
  // caller of SessionEstablisher. SessionRepository is exported for logout and password changes.
  providers: [
    RequestContextService,
    SessionEstablisher,
    SchoolSessionResolver,
    SessionRepository,
    OwnSchoolRepository,
  ],
  exports: [RequestContextService, SchoolSessionResolver, SessionRepository, OwnSchoolRepository],
})
export class TenancyModule {}
