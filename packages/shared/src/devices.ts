/** Mobile sessions and devices (phase-2-daily-operations.md §4.8, §5, slice 9). */

/** A token is accepted only on the channel it was minted for (Postgres enum session_channel). */
export const SESSION_CHANNELS = ['cookie', 'bearer'] as const;
export type SessionChannel = (typeof SESSION_CHANNELS)[number];

export const DEVICE_PLATFORMS = ['android', 'ios'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_UNREGISTERED_REASONS = ['sign_out', 'fcm_unregistered', 'replaced'] as const;
export type DeviceUnregisteredReason = (typeof DEVICE_UNREGISTERED_REASONS)[number];

/** `X-App-Version`, compared numerically with MOBILE_MIN_APP_VERSION (R161). */
export const APP_VERSION_PATTERN = /^[0-9]{1,4}(\.[0-9]{1,4}){2}$/;

/** What a login is to the school (contracts/slice-9.md §2.1; MeDto.capacities). */
export const CAPACITIES = ['staff', 'guardian', 'student'] as const;
export type Capacity = (typeof CAPACITIES)[number];
