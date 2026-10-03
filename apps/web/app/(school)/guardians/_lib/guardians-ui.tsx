'use client';

import { CONTACT_CAPABILITIES, IDENTITY_INPUT_PATTERN, normalisePhone } from '@asms/shared';
import { useId } from 'react';
import { useController, useWatch, type Control, type FieldValues, type Path } from 'react-hook-form';
import { z } from 'zod';
import { FormField } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';
import type { ContactCapability } from '@/lib/api/school-guardians-contract';

// Pieces shared by the guardian list, lookup, create and detail screens (contracts/slice-5.md).

export const guardiansKeys = {
  all: ['school', 'guardians'] as const,
  list: ['school', 'guardians', 'list'] as const,
  detail: (id: string) => ['school', 'guardians', 'detail', id] as const,
  students: (id: string) => ['school', 'guardians', 'students', id] as const,
};

/** Rule 17: three values, no "unknown". */
export const CONTACT_CAPABILITY_LABELS: Record<ContactCapability, string> = {
  whatsapp: 'WhatsApp',
  smartphone_data: 'Smartphone with data',
  keypad: 'Keypad phone',
};

/** Formats CNIC digits as they are typed: 35201-1234567-1. Anything but digits is dropped. */
export function formatIdentityInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 13);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

// ---- Form rules (§3.4). The API repeats every one; these only save a round trip. ----

export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters.')
  .max(200, 'Use at most 200 characters.')
  .regex(/^\P{Cc}*$/u, 'Remove line breaks and control characters.');

/** Blank, or 13 digits dashed as 5-7-1. */
export const optionalCnicSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || IDENTITY_INPUT_PATTERN.test(v), 'Enter all 13 digits, as 35201-1234567-1.');

export const contactFieldsSchema = z.object({
  phone: z
    .string()
    .trim()
    .refine((v) => v === '' || normalisePhone(v) !== null, 'Enter a mobile number such as 0300 1234567.'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Use at most 254 characters.')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.'),
  // A string so the radio group can start with nothing chosen.
  contactCapability: z
    .string()
    .refine((v) => v in CONTACT_CAPABILITY_LABELS, 'Choose how this guardian can be reached.'),
  address: z.string().trim().max(500, 'Use at most 500 characters.'),
});
export type ContactFieldValues = z.input<typeof contactFieldsSchema>;

/** `''` becomes null: the API reads null as "not given" on create and "clear" on edit. */
export const blankToNull = (value: string) => (value.trim() === '' ? null : value.trim());

/**
 * Phone, email, contact capability and address: the fields create and edit share. The phone
 * preview shows what the server is expected to store; the server's answer is authoritative.
 */
export function ContactFields<T extends FieldValues & ContactFieldValues>({
  control,
  disabled,
}: {
  control: Control<T>;
  disabled?: boolean;
}) {
  const phone = (useWatch({ control, name: 'phone' as Path<T> }) as string | undefined) ?? '';
  const normalised = phone.trim() ? normalisePhone(phone) : null;
  return (
    <>
      <FormField
        control={control}
        name={'phone' as Path<T>}
        label="Mobile phone (optional)"
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
      <ContactCapabilityField control={control} disabled={disabled} />
      <FormField
        control={control}
        name={'email' as Path<T>}
        label="Email (optional)"
        type="email"
        autoComplete="off"
        maxLength={254}
        disabled={disabled}
        hint="Contact only. It is not used as the guardian's login reset address."
      />
      <FormField
        control={control}
        name={'address' as Path<T>}
        label="Address (optional)"
        maxLength={500}
        disabled={disabled}
      />
    </>
  );
}

const CAPABILITY_HINTS: Record<ContactCapability, string> = {
  whatsapp: 'Messages go by WhatsApp.',
  smartphone_data: 'Can use the parent app.',
  keypad: 'SMS only; the office resets this login.',
};

/** Contact capability as a required radio group with nothing preselected (§6, rule 17). */
function ContactCapabilityField<T extends FieldValues>({
  control,
  disabled,
}: {
  control: Control<T>;
  disabled?: boolean;
}) {
  const { field, fieldState } = useController({ control, name: 'contactCapability' as Path<T> });
  const id = useId();
  const error = fieldState.error?.message;
  return (
    <fieldset
      className="grid gap-1.5"
      aria-describedby={error ? `${id}-error` : undefined}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend className="mb-1.5 text-sm font-medium">How can this guardian be reached?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {CONTACT_CAPABILITIES.map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm has-checked:border-primary has-checked:bg-muted/50 has-disabled:cursor-not-allowed has-disabled:opacity-60"
          >
            <input
              type="radio"
              name={field.name}
              value={value}
              checked={field.value === value}
              onChange={() => field.onChange(value)}
              onBlur={field.onBlur}
              ref={value === CONTACT_CAPABILITIES[0] ? field.ref : undefined}
              className="mt-0.5 size-4 accent-primary"
            />
            <span className="grid gap-0.5">
              <span className="font-medium">{CONTACT_CAPABILITY_LABELS[value]}</span>
              <span className="text-xs text-muted-foreground">{CAPABILITY_HINTS[value]}</span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** "No CNIC" / "No phone" flags of the list (§2). */
export function MissingBadge({ children }: { children: React.ReactNode }) {
  return <Badge variant="outline">{children}</Badge>;
}

/** "father of Ali, Class 5" for each live link of a lookup hit. */
export function describeStudents(
  students: { fullName: string; className: string | null; relationship: string }[],
): string | null {
  if (students.length === 0) return null;
  return students
    .map((s) => `${s.relationship} of ${s.fullName}${s.className ? `, ${s.className}` : ''}`)
    .join('; ');
}

