import type { Capability } from '@asms/shared';
import {
  ActivityIcon,
  BanknoteIcon,
  BookOpenIcon,
  BookOpenCheckIcon,
  CalendarCheckIcon,
  ClipboardCheckIcon,
  UserCheckIcon,
  CalendarDaysIcon,
  CircleUserRoundIcon,
  SchoolIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  IdCardIcon,
  KeyRoundIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  InboxIcon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * Sidebar entries. `capability` is the key that shows the entry (plan §7), or a list of keys any
 * one of which shows it; null means every signed-in user of that console sees it. Hiding an entry is a convenience only: the API
 * enforces every capability itself.
 * The school console feeds `visibleNav` from GET /me's effective capabilities.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  capability: Capability | readonly Capability[] | null;
};

export const schoolNav: NavItem[] = [
  { href: '/students', label: 'Students', icon: UserRoundIcon, capability: 'student.view' },
  { href: '/staff', label: 'Staff', icon: IdCardIcon, capability: 'staff.view' },
  { href: '/guardians', label: 'Guardians', icon: UsersRoundIcon, capability: 'guardian.manage' },
  // Registers are read with either key and written with mark (contracts/slice-11.md §1.1).
  {
    href: '/attendance',
    label: 'Attendance',
    icon: ClipboardCheckIcon,
    capability: ['attendance.student.mark', 'attendance.student.view_all'],
  },
  // Office staff do not hold diary.write by default, so they do not see the diary (slice-13 §1.1).
  { href: '/diary', label: 'Diary', icon: BookOpenCheckIcon, capability: 'diary.write' },
  // Senders read their own announcements, or every one with .school (contracts/slice-14.md §1.1).
  {
    href: '/announcements',
    label: 'Announcements',
    icon: MegaphoneIcon,
    capability: ['announcement.send.scope', 'announcement.send.school'],
  },
  {
    href: '/staff-attendance',
    label: 'Staff attendance',
    icon: UserCheckIcon,
    capability: 'attendance.staff.manage',
  },
  // Every staff member reads their own record (@RequireStaff, contracts/slice-12.md §4.4).
  { href: '/my-attendance', label: 'My attendance', icon: CalendarCheckIcon, capability: null },
  // Every staff member may read the academic structure (@RequireStaff); writes are per capability.
  { href: '/academics', label: 'Academic structure', icon: BookOpenIcon, capability: null },
  // Every staff member may read the published calendar (@RequireStaff); drafts and writes need
  // holiday.manage (contracts/slice-10.md §1).
  { href: '/calendar', label: 'Calendar', icon: CalendarDaysIcon, capability: null },
  // Fee heads and the fee structure are read with any finance key; writes need fee_head.manage
  // (phase-3-financial.md slice 18). Teachers hold none of these.
  {
    href: '/fees',
    label: 'Fees',
    icon: BanknoteIcon,
    capability: ['fee_head.manage', 'charge.create', 'fee.statement.view', 'payment.record'],
  },
  {
    href: '/users',
    label: 'User accounts',
    icon: ShieldCheckIcon,
    capability: 'user.account.manage',
  },
  // Readable with user.account.manage, so the office can name a custom role; writes need
  // role.manage, which only a principal holds (contracts/slice-7.md §1, §9).
  {
    href: '/custom-roles',
    label: 'Custom roles',
    icon: KeyRoundIcon,
    capability: 'user.account.manage',
  },
  {
    href: '/settings',
    label: 'School settings',
    icon: SettingsIcon,
    capability: 'school.settings.manage',
  },
  // WhatsApp, the SMS allow list, usage and test messages (contracts/slice-9.md §5, §14).
  {
    href: '/settings/messaging',
    label: 'Messaging',
    icon: MessageSquareIcon,
    capability: 'school.settings.manage',
  },
  // Every signed-in person reads the messages addressed to them (contracts/slice-14.md §7).
  { href: '/inbox', label: 'Inbox', icon: InboxIcon, capability: null },
  // Every signed-in school user: email, password (slice 2).
  { href: '/account', label: 'Your account', icon: CircleUserRoundIcon, capability: null },
];

// Platform admins hold no capabilities (plan §7): their console shows every entry.
export const platformNav: NavItem[] = [
  { href: '/platform/schools', label: 'Schools', icon: SchoolIcon, capability: null },
  { href: '/platform/messaging', label: 'Delivery health', icon: ActivityIcon, capability: null },
  { href: '/platform/settings', label: 'Platform settings', icon: SlidersHorizontalIcon, capability: null },
];

export function visibleNav(items: NavItem[], capabilities: ReadonlySet<string>): NavItem[] {
  return items.filter((item) => {
    if (item.capability === null) return true;
    const any: readonly string[] = typeof item.capability === 'string' ? [item.capability] : item.capability;
    return any.some((capability) => capabilities.has(capability));
  });
}
