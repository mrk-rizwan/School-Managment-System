import { DEFAULT_TIMEZONE, formatDay, todayInSchool, type AnnouncementCategory } from '@asms/shared';
import type { InboxItemDto } from '../api/contracts';

// The inbox (slice-16 §7.3, contracts/slice-14.md §7), pure. Nothing here records that a message
// was opened: there is no such field (R150, plan §0.13).

export const INBOX_LIMIT = 25;

export const CATEGORY_CHIPS: { value: AnnouncementCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'holiday', label: 'Holiday' },
  { value: 'exam', label: 'Exam' },
  { value: 'fee', label: 'Fee' },
  { value: 'event', label: 'Event' },
  { value: 'general', label: 'General' },
];

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: DEFAULT_TIMEZONE,
});
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE });

/** "09:32" when sent today in school time, else the date. */
export function sentLabel(sentAt: string, today: string = todayInSchool()): string {
  const instant = new Date(sentAt);
  const day = dayFormat.format(instant);
  return day === today ? timeFormat.format(instant) : formatDay(day);
}

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

export const attachmentWord = (mime: InboxItemDto['attachmentMime']) =>
  mime === null ? null : mime === 'application/pdf' ? 'PDF' : 'Photo';
