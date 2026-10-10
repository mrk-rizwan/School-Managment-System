import type { Capability } from '@asms/shared';
import {
  ActivityIcon,
  AwardIcon,
  BanknoteIcon,
  BookOpenIcon,
  BookOpenCheckIcon,
  CalendarCheckIcon,
  CalendarOffIcon,
  PlaneIcon,
  ClipboardCheckIcon,
  ClipboardPenLineIcon,
  UserCheckIcon,
  CalendarDaysIcon,
  CalendarClockIcon,
  CircleUserRoundIcon,
  SchoolIcon,
  SettingsIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  IdCardIcon,
  KeyRoundIcon,
  LayersIcon,
  ReceiptTextIcon,
  ReceiptIcon,
  WalletIcon,
  FileTextIcon,
  GraduationCapIcon,
  ChartColumnIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  InboxIcon,
  ListChecksIcon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
  WalletCardsIcon,
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
  /** Shown only to a session holding this capacity (a guardian's own pages, slice 21; staff pages, slice 37). */
  capacity?: 'staff' | 'guardian' | 'student';
};

export const schoolNav: NavItem[] = [
  // Phase 3 slice 27: the decision queues and the principal's tiles, for whoever holds one of the
  // four decision keys (R227).
  {
    href: '/approvals',
    label: 'Approvals',
    icon: ListChecksIcon,
    capability: ['payment.verify', 'collection.handover.confirm', 'expense.approve', 'staff.leave.approve'],
  },
  { href: '/students', label: 'Students', icon: UserRoundIcon, capability: 'student.view' },
  // Phase 4 slice 34: the certificates register (contracts/slice-34.md §8).
  { href: '/certificates', label: 'Certificates', icon: AwardIcon, capability: 'certificate.issue' },
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
  // Phase 4 slice 30: tests and exams of the caller's sections and subjects, or the school's with
  // marks.view_all (contracts/slice-30.md §8).
  { href: '/marks', label: 'Marks', icon: ClipboardPenLineIcon, capability: ['marks.enter', 'marks.view_all'] },
  // Phase 4 slice 31: the section result sheets the caller reads (contracts/slice-31.md §9).
  {
    href: '/results/sheets',
    label: 'Results',
    icon: GraduationCapIcon,
    capability: ['marks.enter', 'marks.view_all', 'result.approve'],
  },
  // Phase 4 slice 32: corrections of marks on published results (contracts/slice-32.md §8).
  {
    href: '/results/corrections',
    label: 'Mark corrections',
    icon: ClipboardPenLineIcon,
    capability: ['result.approve', 'marks.view_all'],
  },
  // Phase 4 slice 33: the result reports from the stored rows (contracts/slice-33.md §3).
  { href: '/results/reports', label: 'Result reports', icon: ChartColumnIcon, capability: 'marks.view_all' },
  // Phase 4 slice 35: the year-end promotion sheets (contracts/slice-35.md).
  { href: '/promotion', label: 'Promotion', icon: GraduationCapIcon, capability: 'assessment.define' },
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
  // Phase 3 slice 24: every staff member's own leave (@RequireStaff); the approvers' queue and the
  // leave types (staff.leave.approve, school.settings.manage).
  { href: '/my-leave', label: 'My leave', icon: PlaneIcon, capability: null },
  {
    href: '/leave',
    label: 'Staff leave',
    icon: CalendarOffIcon,
    capability: ['staff.leave.approve', 'school.settings.manage'],
  },
  // Every staff member may read the academic structure (@RequireStaff); writes are per capability.
  { href: '/academics', label: 'Academic structure', icon: BookOpenIcon, capability: null },
  // Phase 5 slice 37: every staff member reads any section's week (@RequireStaff); versions,
  // substitutions and the grid need timetable.manage (contracts/slice-37.md §7).
  { href: '/timetable', label: 'Timetable', icon: CalendarClockIcon, capability: null, capacity: 'staff' },
  // Every staff member may read the published calendar (@RequireStaff); drafts and writes need
  // holiday.manage (contracts/slice-10.md §1).
  { href: '/calendar', label: 'Calendar', icon: CalendarDaysIcon, capability: null },
  // Fee heads and the fee structure are read with any finance key; writes need fee_head.manage
  // (phase-3-financial.md slice 18). Teachers hold none of these.
  {
    href: '/fees',
    label: 'Fees',
    icon: BanknoteIcon,
    capability: ['fee_head.manage', 'charge.create', 'fee.statement.view', 'payment.record', 'payment.verify'],
  },
  // Phase 3 slice 21: a guardian's children's fees, receipts and deposit slips (/me/*).
  { href: '/my-children', label: "Children's fees", icon: WalletCardsIcon, capability: null, capacity: 'guardian' },
  // Phase 4 slice 33: a guardian's children's results and the student's own (/me/*).
  { href: '/my-children/results', label: "Children's results", icon: GraduationCapIcon, capability: null, capacity: 'guardian' },
  { href: '/my-results', label: 'My results', icon: GraduationCapIcon, capability: null, capacity: 'student' },
  // Recorders, approvers and report readers (phase-3-financial.md slice 23).
  {
    href: '/expenses',
    label: 'Expenses',
    icon: ReceiptIcon,
    capability: ['expense.record', 'expense.approve', 'finance.report.view'],
  },
  // Phase 3 slice 25: payroll runs and advances (payroll.view; payroll.run writes) and every staff
  // member's own payslips (@RequireStaff).
  { href: '/payroll', label: 'Payroll', icon: WalletIcon, capability: ['payroll.view', 'payroll.run'] },
  { href: '/my-payslips', label: 'My payslips', icon: FileTextIcon, capability: null },
  // Phase 3 slice 22
  { href: '/reports', label: 'Finance reports', icon: ChartColumnIcon, capability: 'finance.report.view' },
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
  // Slice 26: platform billing.
  { href: '/platform/plans', label: 'Plans', icon: LayersIcon, capability: null },
  { href: '/platform/invoices', label: 'Invoices', icon: ReceiptTextIcon, capability: null },
  { href: '/platform/settings', label: 'Platform settings', icon: SlidersHorizontalIcon, capability: null },
];

export function visibleNav(
  items: NavItem[],
  capabilities: ReadonlySet<string>,
  capacities: ReadonlySet<string> = new Set(),
): NavItem[] {
  return items.filter((item) => {
    if (item.capacity !== undefined && !capacities.has(item.capacity)) return false;
    if (item.capability === null) return true;
    const any: readonly string[] = typeof item.capability === 'string' ? [item.capability] : item.capability;
    return any.some((capability) => capabilities.has(capability));
  });
}
