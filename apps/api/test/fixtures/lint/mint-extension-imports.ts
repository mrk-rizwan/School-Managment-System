import { schoolIdFromLookup } from '../../tenancy/school-id.mint.js';
import { scopeAll } from '../../tenancy/scope.mint.ts';

export const mint = [schoolIdFromLookup, scopeAll];
