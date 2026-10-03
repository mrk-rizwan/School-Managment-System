import { IDENTITY_INPUT_PATTERN } from '@asms/shared';
import { z } from 'zod';

// Form rules shared across screens. The API repeats every one; these only save a round trip.

/**
 * A name: trimmed, length-bounded, no control characters (the API also collapses spaces).
 * People and schools use `nameSchema(2, 200)`.
 */
export function nameSchema(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min, min === 1 ? 'Enter a name.' : `Use at least ${min} characters.`)
    .max(max, `Use at most ${max} characters.`)
    .regex(/^\P{Cc}*$/u, 'Remove line breaks and control characters.');
}

/** Blank, or 13 digits dashed as 5-7-1. */
export const optionalCnicSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || IDENTITY_INPUT_PATTERN.test(v), 'Enter all 13 digits, as #####-#######-#.');

/** A school user's new password: 8–128 characters. The API also refuses the username digits. */
export const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128, 'Use at most 128 characters.');

/** `''` becomes null: the API reads null as "not given" on create and "clear" on edit. */
export const blankToNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** Formats CNIC / B-Form digits as they are typed: #####-#######-#. Anything but digits is dropped. */
export function formatIdentityInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 13);
  if (digits.length <= 5) return digits;
  if (digits.length <= 12) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}
