import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from './request-context';

// Exception 7, the second of the three read-only layers (contracts/slice-45.md §3): whether the
// current CLS context is a platform support read. Read by the query guard (src/repositories/prisma.ts),
// which has no injector; written only by SupportReadContext.run (./support-read-context.ts).

/** True inside SupportReadContext.run, false everywhere else (no context at all included). */
export function inSupportContext(): boolean {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  return cls.isActive() && cls.get('support') === true;
}
