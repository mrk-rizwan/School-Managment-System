import { createHmac } from 'node:crypto';
import type { SchoolId } from '../tenancy/school-id';

/**
 * Identity numbers (CNIC, B-Form) are looked up by a keyed hash and shown only masked
 * (plan §3.6, contracts/slice-2.md §2). The key is IDENTITY_HASH_KEY, separate from the field
 * encryption keyring so rotating one never breaks the other. Callers pass normalised 13 digits
 * (`normaliseIdentityDigits` from @asms/shared).
 */
export function identityHash(digits: string, key: string): string {
  if (!/^[0-9]{13}$/.test(digits)) throw new Error('identityHash expects 13 normalised digits');
  return createHmac('sha256', Buffer.from(key, 'base64')).update(digits).digest('hex');
}

/** `3520112345671` → `35201-*****-1`. Never returns the middle seven digits. */
export function maskIdentityNumber(digits: string): string {
  if (!/^[0-9]{13}$/.test(digits)) throw new Error('maskIdentityNumber expects 13 digits');
  return `${digits.slice(0, 5)}-*****-${digits.slice(12)}`;
}

/** The encrypted identity-number columns (plan §3.6). */
export type IdentityColumn =
  | { table: 'staff' | 'guardians'; column: 'cnic' }
  | { table: 'students'; column: 'b_form' };

/**
 * Field-encryption AAD for an identity number: `schoolId|table|column`, binding the ciphertext to
 * its school, table and column. Stored rows were encrypted under these exact strings; changing
 * one makes them undecryptable.
 */
export const identityAad = (schoolId: SchoolId, { table, column }: IdentityColumn): string =>
  `${schoolId}|${table}|${column}`;

export const staffCnicAad = (schoolId: SchoolId): string =>
  identityAad(schoolId, { table: 'staff', column: 'cnic' });
export const guardianCnicAad = (schoolId: SchoolId): string =>
  identityAad(schoolId, { table: 'guardians', column: 'cnic' });
export const bFormAad = (schoolId: SchoolId): string =>
  identityAad(schoolId, { table: 'students', column: 'b_form' });
