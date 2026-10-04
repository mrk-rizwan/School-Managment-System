// Native modules for the jest-expo project (slice-15 §13.1): the secure store in memory, SQLite on
// Node's built-in engine, notifications and connectivity as controllable fakes. Everything above
// them — the session, the outbox, the cache, the client — is the real code.

jest.mock('expo-secure-store', () => jest.requireActual('./src/test/secure-store'));
jest.mock('expo-sqlite', () => jest.requireActual('./src/test/sqlite-adapter'));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.0', android: { package: 'pk.asms.app.dev' } } },
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, canAskAgain: true, status: 'granted' }),
  ),
  requestPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, canAskAgain: true, status: 'granted' }),
  ),
  getDevicePushTokenAsync: jest.fn(() => Promise.resolve({ type: 'android', data: 'fcm-token-1' })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('@react-native-community/netinfo', () =>
  jest.requireActual('@react-native-community/netinfo/jest/netinfo-mock.js'),
);

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>('react-native-safe-area-context/jest/mock').default,
);

process.env.EXPO_PUBLIC_API_URL = 'http://api.test';
process.env.EXPO_PUBLIC_PUSH_ENABLED = 'false';
