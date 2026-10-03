/**
 * CNIC / B-Form (13-digit national identity numbers): input normalisation and free-text
 * detection, shared by the API and the web forms (contracts/slice-2.md §2).
 */

/** Accepted input forms: 13 digits, optionally dashed as 5-7-1. */
export const IDENTITY_INPUT_PATTERN = /^[0-9]{5}-?[0-9]{7}-?[0-9]$/;

/** Strips dashes and spaces; returns the 13 digits, or null if the result is not 13 digits. */
export function normaliseIdentityDigits(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^[0-9]{13}$/.test(digits) ? digits : null;
}

/** True if free text carries an identity number, plain or dashed (refused in names and reasons). */
export function containsIdentityNumber(text: string): boolean {
  return /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/.test(text);
}
