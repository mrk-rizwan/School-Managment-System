import Constants from 'expo-constants';
import { apiUrl, DEV_FALLBACK_API_URL } from './config';

// Security review advisory: a non-development build with no API URL fails loudly instead of
// falling back to the emulator's cleartext address.

const expoConfig = Constants.expoConfig as { extra?: { profile?: string } };
const savedUrl = process.env.EXPO_PUBLIC_API_URL;

afterEach(() => {
  process.env.EXPO_PUBLIC_API_URL = savedUrl;
  delete expoConfig.extra;
});

test('the build URL wins whenever it is set', () => {
  expoConfig.extra = { profile: 'production' };
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.pk';
  expect(apiUrl()).toBe('https://api.example.pk');
});

test('a development build with no URL uses the emulator address', () => {
  expoConfig.extra = { profile: 'development' };
  process.env.EXPO_PUBLIC_API_URL = '';
  expect(apiUrl()).toBe(DEV_FALLBACK_API_URL);
});

test.each(['preview', 'production'])('a %s build with no URL throws', (profile) => {
  expoConfig.extra = { profile };
  process.env.EXPO_PUBLIC_API_URL = '';
  expect(() => apiUrl()).toThrow(`EXPO_PUBLIC_API_URL is not set for the "${profile}" build`);
});
