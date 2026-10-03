/** Guardian values (contracts/slice-5.md), for the API and the web. */

/** Rule 17: how a guardian can be reached. Unknown is not a value. */
export const CONTACT_CAPABILITIES = ['whatsapp', 'smartphone_data', 'keypad'] as const;
export type ContactCapability = (typeof CONTACT_CAPABILITIES)[number];

export const GUARDIAN_STATUSES = ['active', 'merged'] as const;
export type GuardianStatus = (typeof GUARDIAN_STATUSES)[number];
