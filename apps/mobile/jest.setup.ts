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

// Slice 16 (§15.1): the media and screen modules. The file system is an in-memory map; the
// picker, manipulator, sharing and screen-capture calls are jest.fn()s a test can drive; expo-image
// renders a View that records its source, so a test can prove when (and how) an image is asked for.
jest.mock('expo-file-system', () => jest.requireActual('./src/test/file-system'));

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(() => Promise.resolve()) }));

jest.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: jest.fn(() => Promise.resolve()),
  allowScreenCaptureAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  requestMediaLibraryPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchCameraAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })),
  launchImageLibraryAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })),
}));

jest.mock('expo-image-manipulator', () => {
  const fs = jest.requireActual<typeof import('./src/test/file-system')>('./src/test/file-system');
  let n = 0;
  const manipulate = jest.fn((uri: string) => {
    const resizes: unknown[] = [];
    const context = {
      uri,
      resizes,
      resize(size: unknown) {
        resizes.push(size);
        return context;
      },
      renderAsync: () =>
        Promise.resolve({
          saveAsync: (options: { compress?: number; format?: string }) => {
            n += 1;
            const out = `${fs.CACHE}ImageManipulator/out-${n}.jpg`;
            fs.putFile(
              out,
              (globalThis as { __manipulatedSize?: number }).__manipulatedSize ?? 350_000,
            );
            return Promise.resolve({ uri: out, width: 1600, height: 1200, options });
          },
        }),
    };
    return context;
  });
  return { ImageManipulator: { manipulate }, SaveFormat: { JPEG: 'jpeg', PNG: 'png' } };
});

jest.mock('expo-image', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Image = (props: { source?: unknown; testID?: string }) =>
    React.createElement(View, {
      testID: props.testID,
      accessibilityLabel: 'image',
      // The source rides on a data prop so a test can read what was asked for.
      ...({ source: props.source } as object),
    });
  Image.clearDiskCache = jest.fn(() => Promise.resolve(true));
  Image.clearMemoryCache = jest.fn(() => Promise.resolve(true));
  return { Image };
});

// expo-router outside a navigator: screens get a router whose calls a test can read.
jest.mock('expo-router', () => {
  const router = {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    navigate: jest.fn(),
    setParams: jest.fn(),
  };
  return {
    router,
    useRouter: () => router,
    useLocalSearchParams: jest.fn(() => ({})),
    Stack: Object.assign(() => null, { Screen: () => null, Protected: () => null }),
    Tabs: Object.assign(() => null, { Screen: () => null }),
  };
});
