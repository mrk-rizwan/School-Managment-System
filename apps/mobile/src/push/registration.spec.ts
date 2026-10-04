import * as Notifications from 'expo-notifications';
import { readPushToken } from '../auth/session-store';
import { bindOwner, getMeta, META, setMeta } from '../db/database';
import { listByState } from '../db/outbox.repository';
import { transition } from '../outbox/machine';
import { logText } from '../platform/log';
import { resetDevice } from '../test/fake-api';
import {
  listenForTokenRefresh,
  onDeviceRegistered,
  PERMISSION_RETRY_MS,
  registerForPush,
} from './registration';

// slice-15 §8, R159, R173.

const mocked = Notifications as jest.Mocked<typeof Notifications>;
const yes = () => Promise.resolve(true);
const NOW = new Date('2026-10-04T04:00:00.000Z');

beforeEach(async () => {
  await resetDevice();
  await bindOwner('41', '7'); // registration runs signed in: the rows have an owner
  process.env.EXPO_PUBLIC_PUSH_ENABLED = 'true';
  mocked.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true } as never);
  mocked.requestPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true } as never);
  mocked.getDevicePushTokenAsync.mockResolvedValue({ type: 'android', data: 'fcm-token-1' });
});

afterAll(() => {
  process.env.EXPO_PUBLIC_PUSH_ENABLED = 'false';
});

test('no Firebase → skipped and logged, no throw, no outbox row, no native call', async () => {
  process.env.EXPO_PUBLIC_PUSH_ENABLED = 'false';
  await expect(registerForPush(yes, NOW)).resolves.toBe('skipped_no_firebase');
  expect(await listByState('pending')).toHaveLength(0);
  expect(mocked.getDevicePushTokenAsync).not.toHaveBeenCalled();
  expect(logText()).toContain('push.skipped {"cause":"no_firebase"}');
});

test('permission denied → skipped; not asked again within 30 days', async () => {
  mocked.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true } as never);
  mocked.requestPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true } as never);
  await expect(registerForPush(yes, NOW)).resolves.toBe('skipped_permission');
  expect(await getMeta(META.pushPermissionAskedAt)).toBe(NOW.toISOString());
  expect(mocked.requestPermissionsAsync).toHaveBeenCalledTimes(1);

  await registerForPush(yes, new Date(NOW.getTime() + PERMISSION_RETRY_MS - 1));
  expect(mocked.requestPermissionsAsync).toHaveBeenCalledTimes(1);

  await registerForPush(yes, new Date(NOW.getTime() + PERMISSION_RETRY_MS + 1));
  expect(mocked.requestPermissionsAsync).toHaveBeenCalledTimes(2);
  expect(await listByState('pending')).toHaveLength(0);
  expect(logText()).toContain('permission_denied');
});

test('declining the context sentence never shows the system prompt', async () => {
  mocked.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true } as never);
  await expect(registerForPush(() => Promise.resolve(false), NOW)).resolves.toBe(
    'skipped_permission',
  );
  expect(mocked.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('granted → one device_register row with the native FCM token; the token is never logged', async () => {
  await expect(registerForPush(yes, NOW)).resolves.toBe('enqueued');
  const rows = await listByState('pending');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    lane: 'device_register',
    method: 'POST',
    path: '/api/v1/me/devices',
  });
  expect(JSON.parse(rows[0]!.body)).toEqual({ platform: 'android', pushToken: 'fcm-token-1' });
  expect(logText()).not.toContain('fcm-token-1');

  // Opening the app again before it is sent queues nothing new.
  await expect(registerForPush(yes, NOW)).resolves.toBe('unchanged');
  expect(await listByState('pending')).toHaveLength(1);
});

test('on done the token is remembered; the same token later → nothing', async () => {
  await registerForPush(yes, NOW);
  const [row] = await listByState('pending');
  const sending = transition(row!, { type: 'send', now: NOW }).item;
  const done = transition(sending, {
    type: 'outcome',
    outcome: { kind: 'response', status: 201, code: null, message: null, retryAfterSeconds: null },
    now: NOW,
  }).item;
  await onDeviceRegistered(done);
  expect(await readPushToken()).toBe('fcm-token-1');
  await setMeta('unrelated', 'x');
  await expect(registerForPush(yes, NOW)).resolves.toBe('unchanged');
});

test('a token refresh → one device_register row', async () => {
  let listener: ((token: { type: string; data: string }) => void) | undefined;
  mocked.addPushTokenListener.mockImplementation((fn) => {
    listener = fn;
    return { remove: jest.fn() };
  });
  const enqueued = jest.fn();
  const off = listenForTokenRefresh(enqueued);
  listener!({ type: 'android', data: 'fcm-token-2' });
  // The listener queues asynchronously: wait for it rather than for a fixed time.
  for (let i = 0; i < 100 && enqueued.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rows = await listByState('pending');
  expect(rows.map((r) => JSON.parse(r.body).pushToken)).toEqual(['fcm-token-2']);
  expect(enqueued).toHaveBeenCalledTimes(1);
  off();
});

test('a native failure is logged by name, never thrown', async () => {
  mocked.getDevicePushTokenAsync.mockRejectedValue(new Error('FIS_AUTH_ERROR'));
  await expect(registerForPush(yes, NOW)).resolves.toBe('failed');
  expect(logText()).toContain('push.failed');
});
