import { createHash } from 'node:crypto';
import type { SchoolId } from '../tenancy/school-id';

// How provider references and provider secrets are stored (contracts/slice-9.md §8.2, §8.3,
// §13.3, R111). One definition, used by the processor that writes a reference and the webhooks
// that look it up, so the two can never hash differently.

/** `SHA-256(channel + '|' + ref)`: the only form a provider reference is stored in. */
export const providerRefHash = (channel: 'whatsapp' | 'sms', ref: string): string =>
  createHash('sha256').update(`${channel}|${ref}`).digest('hex');

/** AAD of `message_deliveries.poll_ref` (a pull provider's reference, encrypted). */
export const pollRefAad = (schoolId: SchoolId): string => `${schoolId}|message_deliveries|poll_ref`;

/** AAD of `whatsapp_numbers.cloud_access_token`. */
export const cloudTokenAad = (schoolId: SchoolId): string =>
  `${schoolId}|whatsapp_numbers|cloud_access_token`;
