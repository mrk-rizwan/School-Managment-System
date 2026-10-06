import { Capability } from '@asms/shared';
import type { MeDto } from '../api/contracts';

// Tab composition from /me (R156), one pure function: no React, no I/O (slice-15 §5). Scope comes
// from assignment data, never from a capability alone (rule 13): a teacher whose assignments have
// ended has no Classes tab. A tab the API would refuse is never produced.

export const TAB_ORDER = [
  'home',
  'approvals',
  'classes',
  'today',
  'announce',
  'children',
  'student',
  'inbox',
  'calendar',
  'account',
] as const;

export type TabId = (typeof TAB_ORDER)[number];

export type TabSource = Pick<MeDto, 'capacities' | 'capabilities' | 'assignments'>;

export function composeTabs(me: TabSource): TabId[] {
  if (me.capacities.length === 0) return [];
  const staff = me.capacities.includes('staff');
  const cap = (capability: Capability) => me.capabilities.includes(capability);
  const assigned = me.assignments.length > 0;

  const shown: Record<TabId, boolean> = {
    home: true,
    // Phase 3 slice 27 (R227): whoever holds one of the four decision keys. Second, so a principal
    // finds it in the bar (the principal's app is an approvals inbox; CLAUDE.md "Design").
    approvals:
      staff &&
      (cap(Capability.PAYMENT_VERIFY) ||
        cap(Capability.COLLECTION_HANDOVER_CONFIRM) ||
        cap(Capability.EXPENSE_APPROVE) ||
        cap(Capability.STAFF_LEAVE_APPROVE)),
    classes:
      staff &&
      assigned &&
      (cap(Capability.ATTENDANCE_STUDENT_MARK) ||
        cap(Capability.DIARY_WRITE) ||
        cap(Capability.REMARK_WRITE)),
    today: staff && cap(Capability.ATTENDANCE_STUDENT_VIEW_ALL),
    announce: staff && cap(Capability.ANNOUNCEMENT_SEND_SCHOOL),
    children: me.capacities.includes('guardian'),
    student: me.capacities.includes('student'),
    inbox: true,
    calendar: true,
    account: true,
  };
  return TAB_ORDER.filter((tab) => shown[tab]);
}

export const BOTTOM_BAR_SLOTS = 5;

export type TabLayout = { bar: (TabId | 'more')[]; more: TabId[] };

/** At most five slots: when more tabs are shown, the first four and a "More" listing the rest. */
export function layoutTabs(tabs: readonly TabId[]): TabLayout {
  if (tabs.length <= BOTTOM_BAR_SLOTS) return { bar: [...tabs], more: [] };
  const head = tabs.slice(0, BOTTOM_BAR_SLOTS - 1);
  return { bar: [...head, 'more'], more: tabs.slice(BOTTOM_BAR_SLOTS - 1) };
}
