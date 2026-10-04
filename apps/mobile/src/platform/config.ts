import Constants from 'expo-constants';

// Build-time values. EXPO_PUBLIC_* are inlined by Metro at bundle time; they are read lazily so
// tests can set them. The URL is fixed per build (plan §3); app.config.ts refuses a non-https URL
// for any profile but development (slice-15 §2.6).

/** The emulator's view of the developer's machine: the fallback in development builds only. */
export const DEV_FALLBACK_API_URL = 'http://10.0.2.2:3461';

export function apiUrl(): string {
  // Read literally so Metro can inline it.
  const url: unknown = process.env.EXPO_PUBLIC_API_URL;
  if (typeof url === 'string' && url !== '') return url;
  // A release build with no URL must not quietly talk to a cleartext address (review advisory).
  if (!isDevelopmentBuild()) {
    throw new Error(`EXPO_PUBLIC_API_URL is not set for the "${buildProfile()}" build`);
  }
  return DEV_FALLBACK_API_URL;
}

/** The build profile app.config.ts recorded (development when none was given). */
export function buildProfile(): string {
  const profile: unknown = (Constants.expoConfig?.extra as { profile?: unknown } | undefined)
    ?.profile;
  return typeof profile === 'string' ? profile : 'development';
}

function isDevelopmentBuild(): boolean {
  return buildProfile() === 'development';
}

/** False in every build until the owner's Firebase project exists (slice-15 §8). */
export function pushEnabled(): boolean {
  const flag: unknown = process.env.EXPO_PUBLIC_PUSH_ENABLED;
  return flag === 'true';
}

/** The Android package, for the Play Store link on the update screen. */
export function applicationId(): string {
  return Constants.expoConfig?.android?.package ?? 'pk.asms.app';
}
