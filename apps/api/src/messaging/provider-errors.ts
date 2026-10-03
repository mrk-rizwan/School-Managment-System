// Provider error codes mapped to DeliveryErrorCode (R111: provider text is never stored). Shared by
// the Cloud API driver and the Meta webhook (src/webhooks may not import the drivers).
import type { DeliveryErrorCode } from '@asms/shared';

/** Meta's error codes (contracts/slice-9.md §8.3), shared by sends and webhook reports. */
export function metaError(code: number | null): DeliveryErrorCode {
  switch (code) {
    case 131026:
      return 'not_on_whatsapp';
    case 131047:
      return 'outside_window';
    case 130429:
    case 131056:
      return 'rate_limited';
    case 190:
      return 'auth_failed';
    case 132000:
    case 132001:
    case 132012:
      // Template missing, unapproved or its parameters wrong (§5.5 step 3).
      return 'rejected';
    default:
      return 'unknown';
  }
}
