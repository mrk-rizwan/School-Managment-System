// Type-checked by test/guardrails/lint-boundaries.spec.ts. The line after every `// !` must be a
// compile error, and nothing else.
import type { ClsService } from 'nestjs-cls';
import type { RequestContext, RequestContextService } from './request-context';
import type { SessionEstablisher } from './session-establisher';
import type { SchoolId } from './school-id';

export function poison(
  context: RequestContextService,
  establisher: SessionEstablisher,
  cls: ClsService<RequestContext>,
  body: unknown,
  plain: bigint,
): SchoolId | undefined {
  // !
  establisher.establishSession({ schoolId: body, userId: 1n, sessionId: 1n });
  // !
  establisher.establishSession({ schoolId: plain, userId: 1n, sessionId: 1n });
  // !
  cls.set('schoolId', plain);
  // !
  const required: SchoolId = context.schoolId;
  const optional: SchoolId | undefined = context.schoolId;
  // The store is a runtime private (#cls): bracket access cannot reach the raw ClsService.
  // !
  const raw = context['cls'];
  // !
  const writerRaw = establisher['cls'];
  // The read side has no setter at all.
  // !
  context.establishSession({ schoolId: required, userId: 1n, sessionId: 1n });
  // Not refused: ClsService.get infers its return type from the caller (get<R>), which is why
  // nestjs-cls is importable only inside src/tenancy and everything else reads the context here.
  const claimed: SchoolId = cls.get('schoolId');
  return raw ?? writerRaw ?? required ?? optional ?? claimed;
}
