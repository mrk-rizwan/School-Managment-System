'use client';

import {
  Capability,
  DEFAULT_TIMEZONE,
  ErrorCode,
  SYSTEM_ROLE_DEFAULTS,
  SYSTEM_ROLES,
  normalisePhone,
} from '@asms/shared';
import { useWatch, type Control } from 'react-hook-form';
import { z } from 'zod';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import { ApiError, describeApiError } from '@/lib/api/errors';
import { fullNameSchema, optionalCnicSchema } from '../../guardians/_lib/guardians-ui';
import type { StaffStatus, SystemRole, TeacherRole } from '@/lib/api/school-staff-contract';

// Pieces shared by the staff list, create and detail screens (contracts/slice-4.md §8).

export const staffKeys = {
  all: ['school', 'staff'] as const,
  list: ['school', 'staff', 'list'] as const,
  detail: (id: string) => ['school', 'staff', 'detail', id] as const,
  assignments: (id: string) => ['school', 'staff', 'assignments', id] as const,
  roles: (userId: string) => ['school', 'staff', 'roles', userId] as const,
};

export const STAFF_STATUS_LABELS: Record<StaffStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  left: 'Left',
};
const STAFF_STATUS_VARIANT = {
  active: 'secondary',
  suspended: 'destructive',
  left: 'outline',
} as const satisfies Record<StaffStatus, string>;

export function StaffStatusBadge({ status }: { status: StaffStatus }) {
  return <Badge variant={STAFF_STATUS_VARIANT[status]}>{STAFF_STATUS_LABELS[status]}</Badge>;
}

export const ROLE_LABELS: Record<SystemRole, string> = {
  principal: 'Principal',
  office_staff: 'Office staff',
  teacher: 'Teacher',
};

export const TEACHER_ROLE_LABELS: Record<TeacherRole, string> = {
  class_teacher: 'Class teacher',
  subject_teacher: 'Subject teacher',
};

/**
 * The system roles this user may give (§3.6 step 4, R13): all of them with `role.manage`;
 * otherwise only a role whose defaults the user already holds. `principal` therefore always needs
 * `role.manage`. A convenience only: the API refuses anything else with `role_exceeds_actor`.
 */
export function givableRoles(can: (capability: Capability) => boolean): SystemRole[] {
  if (can(Capability.ROLE_MANAGE)) return [...SYSTEM_ROLES];
  return SYSTEM_ROLES.filter(
    (role) => role !== 'principal' && SYSTEM_ROLE_DEFAULTS[role].every((c) => can(c)),
  );
}

/** Today in the school's time zone (Asia/Karachi, CLAUDE.md), as YYYY-MM-DD. */
const todayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: DEFAULT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const schoolToday = () => todayFormat.format(new Date());

// ---- Form rules (§3.3). The API repeats every one; these only save a round trip. The name,
// CNIC and blank-to-null rules are the guardians' (guardians/_lib/guardians-ui.tsx). ----

export const optionalDateSchema = z
  .string()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Enter a date.');

/** The fields create and edit share. `cnic` is blank for "not given" / "keep". */
export const staffFieldsSchema = z.object({
  fullName: fullNameSchema,
  cnic: optionalCnicSchema,
  phone: z
    .string()
    .trim()
    .refine((v) => normalisePhone(v) !== null, 'Enter a mobile number such as 0300 1234567.'),
  designation: z
    .string()
    .trim()
    .max(100, 'Use at most 100 characters.')
    .regex(/^\P{Cc}*$/u, 'Remove line breaks and control characters.'),
  joinedOn: optionalDateSchema,
});
export type StaffFieldValues = z.input<typeof staffFieldsSchema>;

/**
 * The sentence for a staff refusal the office can act on (§3.5, §3.6, §5): the permission
 * reasons in words; anything else is the API's own message (or a 422's field sentence).
 */
export function staffErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const field = error.fieldErrors[0]?.message;
    if (field) return field;
    const reason = (error.details as { reason?: unknown } | null)?.reason;
    if (error.code === ErrorCode.PERMISSION_DENIED) {
      if (reason === 'target_is_principal') {
        return 'Only someone who manages roles can change a principal’s record.';
      }
      if (reason === 'target_exceeds_actor') {
        return 'This person can do things you cannot, so you cannot change their status.';
      }
      if (reason === 'role_exceeds_actor') {
        return 'You can only give a role whose permissions you hold yourself.';
      }
    }
    if (error.code === ErrorCode.LAST_PRINCIPAL) {
      return 'This is the school’s only active principal. Appoint another principal first.';
    }
    if (error.code === ErrorCode.SELF_ACTION_FORBIDDEN) {
      return 'You cannot do this to your own record. Ask another member of staff.';
    }
  }
  return describeApiError(error);
}

/**
 * Phone, designation and joining date: the fields create and edit share after name and CNIC.
 * The phone preview shows what the server is expected to store; its answer is authoritative.
 */
export function StaffMoreFields({ control, disabled }: { control: Control<StaffFieldValues>; disabled?: boolean }) {
  const phone = useWatch({ control, name: 'phone' }) ?? '';
  const normalised = phone.trim() ? normalisePhone(phone) : null;
  return (
    <>
      <FormField
        control={control}
        name="phone"
        label="Mobile phone"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        maxLength={20}
        disabled={disabled}
        hint={
          normalised
            ? `Will be saved as ${normalised}.`
            : 'Pakistani numbers such as 0300 1234567, or international with +.'
        }
      />
      <FormField
        control={control}
        name="designation"
        label="Designation (optional)"
        placeholder="Senior teacher, Accountant…"
        maxLength={100}
        disabled={disabled}
      />
      <FormField control={control} name="joinedOn" label="Joined on (optional)" type="date" disabled={disabled} />
    </>
  );
}
