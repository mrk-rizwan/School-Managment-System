import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_CATEGORY_LABELS,
  formatDate,
  formatTime,
  isTodayInSchool,
  type AnnouncementCategory,
} from '@asms/shared';
import type { InboxItemDto } from '../api/contracts';

// The inbox (slice-16 §7.3, contracts/slice-14.md §7), pure. Nothing here records that a message
// was opened: there is no such field (R150, plan §0.13).

export const INBOX_LIMIT = 25;

export const CATEGORY_CHIPS: { value: AnnouncementCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  ...ANNOUNCEMENT_CATEGORIES.map((value) => ({
    value,
    label: ANNOUNCEMENT_CATEGORY_LABELS[value],
  })),
];

/** "09:32" when sent today in school time, else the date. */
export const sentLabel = (sentAt: string, today?: string): string =>
  isTodayInSchool(sentAt, today) ? formatTime(sentAt) : formatDate(sentAt);

/** "via Ali" — the child's first name, for a parent of several children. */
export const viaLabel = (fullName: string) => `via ${fullName.trim().split(/\s+/)[0] ?? fullName}`;

/** The child screen an item opens, by its message type; null when it is about no child screen. */
export function childScreenOf(
  messageType: InboxItemDto['messageType'],
): 'attendance' | 'diary' | 'remarks' | null {
  switch (messageType) {
    case 'absence_alert':
    case 'late_advice':
    case 'attendance_corrected':
      return 'attendance';
    case 'diary_posted':
      return 'diary';
    case 'remark_posted':
      return 'remarks';
    default:
      return null;
  }
}
