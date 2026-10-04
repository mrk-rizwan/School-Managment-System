import { MESSAGE_SUBJECT_TYPES, type MessageSubjectType } from '@asms/shared';
import { z } from 'zod';
import type { TabId } from '../auth/tabs';

// Where a notification tap goes (slice-15 §8, slice-16 §2), pure and table-tested. A push carries
// only ids, a title and the rendered body (R173). A route is never produced for a tab the user
// does not have (R156): the user's tabs from composeTabs are the third argument. Unknown or
// malformed data opens Home.

const NotificationData = z.object({
  type: z.string().min(1),
  subjectType: z.enum(MESSAGE_SUBJECT_TYPES),
  subjectId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  messageId: z.string().regex(/^[1-9][0-9]{0,18}$/),
});

export const HOME_ROUTE = '/home';

/** The student screen a child-linked type opens (16a interim, before the inbox). */
const STUDENT_SCREEN: Partial<Record<MessageSubjectType, string>> = {
  attendance_alert: '/student/attendance',
  diary_entry: '/student/diary',
  remark: '/student/remarks',
};

export function routeForNotification(
  data: unknown,
  hasScreen: (tab: TabId) => boolean,
  tabs: readonly TabId[],
): string {
  const parsed = NotificationData.safeParse(data);
  if (!parsed.success) return HOME_ROUTE;
  const { subjectType, messageId } = parsed.data;
  const open = (tab: TabId) => hasScreen(tab) && tabs.includes(tab);
  const inbox = open('inbox') ? `/inbox/${messageId}` : null;

  switch (subjectType) {
    case 'register_deadline':
      return open('today') ? '/today' : HOME_ROUTE;
    case 'teacher_assignment':
      return open('classes') ? '/classes' : HOME_ROUTE;
    case 'attendance_alert':
    case 'diary_entry':
    case 'remark':
      // The inbox item names the child and offers "Open <child>" (16b).
      if (inbox !== null) return inbox;
      if (open('children')) return '/children';
      if (open('student')) return STUDENT_SCREEN[subjectType] ?? HOME_ROUTE;
      return HOME_ROUTE;
    default:
      return inbox ?? HOME_ROUTE;
  }
}
