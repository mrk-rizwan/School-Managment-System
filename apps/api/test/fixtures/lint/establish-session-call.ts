import type { SessionEstablisher } from '../../tenancy/session-establisher';
import type { SchoolId } from '../../tenancy/school-id';

export function resolve(context: SessionEstablisher, schoolId: SchoolId): void {
  context.establishSession({ schoolId, userId: 1n, sessionId: 1n });
  context['establishSession']({ schoolId, userId: 1n, sessionId: 1n });
}
