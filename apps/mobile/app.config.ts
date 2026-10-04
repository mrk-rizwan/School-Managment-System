import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// The Expo config, from the environment (slice-15 §2.6, §8).
//
// Profile: APP_PROFILE, else EAS_BUILD_PROFILE, else development. A non-development profile must
// have an https EXPO_PUBLIC_API_URL: the URL is fixed per build and a release build can never be
// pointed at an http endpoint, so this throws at config time.
//
// android.package is PROVISIONAL: `pk.asms.app` (and `pk.asms.app.dev` for development builds, so
// both install side by side) is the main thread's placeholder. It is permanent once published —
// the owner confirms it before the first Play upload (slice-15 §1, §15 item 3).
//
// Firebase: google-services.json is never committed. GOOGLE_SERVICES_JSON names the file; without
// it the build has no Firebase, EXPO_PUBLIC_PUSH_ENABLED must not be true, and push registration
// skips and logs (§8).

const BASE_PACKAGE = 'pk.asms.app'; // PROVISIONAL — owner to confirm before the first Play upload

/** X-App-Version comes from this; it must match APP_VERSION_PATTERN (checked at startup too). */
const VERSION = '0.1.0';

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env as Record<string, string | undefined>;
  const profile = env.APP_PROFILE ?? env.EAS_BUILD_PROFILE ?? 'development';
  const development = profile === 'development';
  const apiUrl = env.EXPO_PUBLIC_API_URL ?? (development ? 'http://10.0.2.2:3461' : '');
  if (!development && !apiUrl.startsWith('https://')) {
    throw new Error(
      `EXPO_PUBLIC_API_URL must be https:// for the "${profile}" profile (got "${apiUrl}")`,
    );
  }

  const servicesPath = env.GOOGLE_SERVICES_JSON;
  const googleServicesFile =
    servicesPath && existsSync(resolve(servicesPath)) ? resolve(servicesPath) : undefined;
  if (env.EXPO_PUBLIC_PUSH_ENABLED === 'true' && googleServicesFile === undefined) {
    throw new Error(
      'EXPO_PUBLIC_PUSH_ENABLED=true needs GOOGLE_SERVICES_JSON to name an existing file',
    );
  }

  return {
    ...config,
    name: development ? 'ASMS Dev' : 'ASMS',
    slug: 'asms',
    scheme: 'asms',
    version: VERSION,
    orientation: 'portrait',
    platforms: ['android'],
    android: {
      package: development ? `${BASE_PACKAGE}.dev` : BASE_PACKAGE,
      ...(googleServicesFile ? { googleServicesFile } : {}),
      // Nothing from this app goes into Android's cloud backup: the token store and the database
      // hold a session and school data.
      allowBackup: false,
    },
    experiments: { typedRoutes: true },
    plugins: [
      'expo-router',
      'expo-secure-store',
      'expo-sqlite',
      'expo-notifications',
      'expo-image',
      'expo-status-bar',
      ['expo-splash-screen', { backgroundColor: '#FFFFFF' }],
      [
        'expo-build-properties',
        {
          // R155 "cleartext traffic is off": every preview and production build says false, which CI
          // asserts on a production-profile prebuild. Only the development profile (its own .dev
          // package, never published) may speak http, to reach the dev API on 10.0.2.2 or through
          // adb reverse; that includes the release-variant APK CI runs on the emulator.
          android: { usesCleartextTraffic: development },
        },
      ],
    ],
    extra: { profile },
  };
};
