import { MESSAGE_SUBJECT_TYPES } from '@asms/shared';
import { z } from 'zod';
import type { TabId } from '../auth/tabs';

// Where a notification tap goes (slice-15 §8), pure and table-tested. A push carries only ids, a
// title and the rendered body (R173). In slice 15 every known subject type routes to the inbox
// item; the inbox screen is slice 16's, so until it is registered the tap opens Home. Unknown or
// malformed data opens Home. Slice 16 refines the table (register_deadline → today, …).

const NotificationData = z.object({
  type: z.string().min(1),
  subjectType: z.enum(MESSAGE_SUBJECT_TYPES),
  subjectId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  messageId: z.string().regex(/^[1-9][0-9]{0,18}$/),
});

export const HOME_ROUTE = '/home';

export function routeForNotification(data: unknown, hasScreen: (tab: TabId) => boolean): string {
  const parsed = NotificationData.safeParse(data);
  if (!parsed.success) return HOME_ROUTE;
  return hasScreen('inbox') ? `/inbox/${parsed.data.messageId}` : HOME_ROUTE;
}
