import { createHmac } from 'node:crypto';

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
