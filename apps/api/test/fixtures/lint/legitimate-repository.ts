// A tenant repository as later slices will write it: Prisma types, the transaction host and the
// SchoolId type are all allowed here.
import type { Prisma } from './generated/prisma/client';
import type { PrismaTxAdapter } from './prisma';
import type { SchoolId } from '../tenancy/school-id';

export interface Example {
  where(schoolId: SchoolId): Prisma.SchoolWhereInput;
  adapter?: PrismaTxAdapter;
}
