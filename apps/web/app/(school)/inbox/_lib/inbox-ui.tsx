'use client';

import { ANNOUNCEMENT_CATEGORY_LABELS } from '@asms/shared';
import { Badge } from '@/components/ui/badge';
import type { InboxItemDto } from '@/lib/api/school-announcements-contract';

// Pieces shared by the inbox list and item (contracts/slice-14.md §7).

/** Urgent first-glance marks: the red edge of concept slide 05, and the category or "Notice" tag. */
export function InboxTags({ item }: { item: Pick<InboxItemDto, 'priority' | 'category' | 'kind'> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {item.priority === 'urgent' && <Badge variant="destructive">Urgent</Badge>}
      <Badge variant="outline">{item.category ? ANNOUNCEMENT_CATEGORY_LABELS[item.category] : 'Notice'}</Badge>
    </span>
  );
}

/** "About Ali", "About Ali and Sara": which of the caller's children put this message here (R165). */
export function aboutLine(item: Pick<InboxItemDto, 'viaStudents'>): string | null {
  const names = item.viaStudents.map((s) => s.fullName);
  if (names.length === 0) return null;
  return `About ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`;
}
