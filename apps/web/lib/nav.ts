import type { Capability } from '@asms/shared';
import {
  BookOpenIcon,
  FlaskConicalIcon,
  CircleUserRoundIcon,
  SchoolIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * Sidebar entries. `capability` is the key that shows the entry (plan §7); null means every
 * signed-in user of that console sees it. Hiding an entry is a convenience only: the API
 * enforces every capability itself.
 * The school console feeds `visibleNav` from GET /me's effective capabilities.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  capability: Capability | null;
};

export const schoolNav: NavItem[] = [
  // Students and Staff arrive with wave B (slices 4 and 6); no link until the page exists.
  { href: '/guardians', label: 'Guardians', icon: UsersRoundIcon, capability: 'guardian.manage' },
  // Every staff member may read the academic structure (@RequireStaff); writes are per capability.
  { href: '/academics', label: 'Academic structure', icon: BookOpenIcon, capability: null },
  {
    href: '/users',
    label: 'User accounts',
    icon: ShieldCheckIcon,
    capability: 'user.account.manage',
  },
  {
    href: '/settings',
    label: 'School settings',
    icon: SettingsIcon,
    capability: 'school.settings.manage',
  },
  // Every signed-in school user: email, password (slice 2).
  { href: '/account', label: 'Your account', icon: CircleUserRoundIcon, capability: null },
  // Throwaway: the slice-0 component demo. Remove with app/(demo).
  { href: '/demo', label: 'Component demo', icon: FlaskConicalIcon, capability: null },
];

// Platform admins hold no capabilities (plan §7): their console shows every entry.
export const platformNav: NavItem[] = [
  { href: '/platform/schools', label: 'Schools', icon: SchoolIcon, capability: null },
];

export function visibleNav(items: NavItem[], capabilities: ReadonlySet<string>): NavItem[] {
  return items.filter((item) => item.capability === null || capabilities.has(item.capability));
}
