import {
  BookOpenIcon,
  CalendarRangeIcon,
  FlaskConicalIcon,
  LayoutDashboardIcon,
  SchoolIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * Sidebar entries. `capability` is the key that shows the entry (plan §7); null means every
 * signed-in user of that console sees it. Hiding an entry is a convenience only: the API
 * enforces every capability itself.
 *
 * TODO(slice 2/7): type `capability` with the Capability enum once packages/shared exports it,
 * and feed `visibleNav` from GET /me's effective capabilities.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  capability: string | null;
};

export const schoolNav: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboardIcon, capability: null },
  { href: '/students', label: 'Students', icon: UserRoundIcon, capability: 'student.view' },
  { href: '/guardians', label: 'Guardians', icon: UsersRoundIcon, capability: 'guardian.manage' },
  { href: '/staff', label: 'Staff', icon: UsersRoundIcon, capability: 'staff.view' },
  { href: '/classes', label: 'Classes', icon: BookOpenIcon, capability: 'class.manage' },
  {
    href: '/academic-years',
    label: 'Academic years',
    icon: CalendarRangeIcon,
    capability: 'academic_year.manage',
  },
  {
    href: '/access',
    label: 'Users and access',
    icon: ShieldCheckIcon,
    capability: 'user.account.manage',
  },
  {
    href: '/settings',
    label: 'School settings',
    icon: SettingsIcon,
    capability: 'school.settings.manage',
  },
  // Throwaway: the slice-0 component demo. Remove with app/(school)/demo.
  { href: '/demo', label: 'Component demo', icon: FlaskConicalIcon, capability: null },
];

// Platform admins hold no capabilities (plan §7): their console shows every entry.
export const platformNav: NavItem[] = [
  { href: '/platform/schools', label: 'Schools', icon: SchoolIcon, capability: null },
];

export function visibleNav(items: NavItem[], capabilities: ReadonlySet<string>): NavItem[] {
  return items.filter((item) => item.capability === null || capabilities.has(item.capability));
}
