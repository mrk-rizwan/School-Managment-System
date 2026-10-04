import Constants from 'expo-constants';
import { APP_VERSION_PATTERN } from '@asms/shared';

// X-App-Version (R161). Asserted at startup: a build with a malformed version fails fast rather
// than meeting a 426 in the field (slice-15 §4.1).

export function readAppVersion(): string {
  const version = Constants.expoConfig?.version;
  if (typeof version !== 'string' || !APP_VERSION_PATTERN.test(version)) {
    throw new Error(`The app version "${String(version)}" does not match APP_VERSION_PATTERN`);
  }
  return version;
}
