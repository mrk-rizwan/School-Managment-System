import { createGuardedClient } from '../../repositories/prisma';
import { DatabaseModule } from '../../repositories/database.module';
import { assertQueryAllowed } from '../../repositories/query-guard.ts';
import type { PrismaTxAdapter } from '../../repositories/prisma.js';

export const reach = [createGuardedClient, DatabaseModule, assertQueryAllowed];
export type Adapter = PrismaTxAdapter;
