import type { SchoolId } from './school-id';

export const brand = (id: bigint): SchoolId => id as SchoolId;
