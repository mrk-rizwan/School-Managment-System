import { PrismaClient } from './generated/prisma/client';
import * as generated from './generated/prisma/client';
import { PrismaClient as Renamed } from './generated/prisma/client';
import type { PrismaClient as ClientType } from './generated/prisma/client';

type Options = ConstructorParameters<typeof ClientType>[0];

export const direct = (options: Options) => new PrismaClient(options);
export const qualified = (options: Options) => new generated.PrismaClient(options);
export const renamed = (options: Options) => new Renamed(options);
