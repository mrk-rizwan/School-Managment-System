'use client';

import { CONTACT_CAPABILITIES, normalisePhone } from '@asms/shared';
import { useId } from 'react';
import { useController, type Control, type FieldValues, type Path } from 'react-hook-form';
import { z } from 'zod';
import { FormField, PhoneField } from '@/components/form-field';
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

// ---- Form rules (§3.4). The API repeats every one; these only save a round trip. The name,
// CNIC and blank-to-null rules are shared (lib/validation.ts). ----

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

/** Phone, email, contact capability and address: the fields create and edit share. */
export function ContactFields<T extends FieldValues & ContactFieldValues>({
  control,
  disabled,
}: {
  control: Control<T>;
  disabled?: boolean;
}) {
  return (
    <>
      <PhoneField control={control} name={'phone' as Path<T>} label="Mobile phone (optional)" disabled={disabled} />
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

/** "father of Ali, Class 5" for each live link of a lookup hit. */
export function describeStudents(
  students: { fullName: string; className: string | null; relationship: string }[],
): string | null {
  if (students.length === 0) return null;
  return students
    .map((s) => `${s.relationship} of ${s.fullName}${s.className ? `, ${s.className}` : ''}`)
    .join('; ');
}

