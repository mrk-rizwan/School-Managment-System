import * as Notifications from 'expo-notifications';
import { z } from 'zod';
import { readPushToken, writePushToken } from '../auth/session-store';
import { getMeta, META, setMeta } from '../db/database';
import { enqueue, listByState } from '../db/outbox.repository';
import { LANES } from '../outbox/lanes';
import type { OutboxItem } from '../outbox/machine';
import { pushEnabled } from '../platform/config';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { routeForNotification } from './routing';
import type { TabId } from '../auth/tabs';

// The ONLY importer of expo-notifications (lint). Push registration works without Firebase
// (slice-15 §8): a build without google-services.json has EXPO_PUBLIC_PUSH_ENABLED=false, logs
// push.skipped and stops. With Firebase, the native FCM token (not an Expo push token: the server
// sends through firebase-admin) goes through the device_register outbox lane. The token is never
// logged: pushToken is a dropped key in the scrubber.

export type PushResult =
  'skipped_no_firebase' | 'skipped_permission' | 'unchanged' | 'enqueued' | 'failed';

/** Ask again no sooner than this after a refusal. */
export const PERMISSION_RETRY_MS = 30 * 24 * 60 * 60_000;

const lane = LANES.device_register;

const DeviceBody = z.object({ platform: z.literal('android'), pushToken: z.string().min(1) });

async function permissionGranted(askContext: () => Promise<boolean>, now: Date): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const askedAt = await getMeta(META.pushPermissionAskedAt);
  if (askedAt !== null && now.getTime() - Date.parse(askedAt) < PERMISSION_RETRY_MS) return false;
  if (!current.canAskAgain) return false;
  await setMeta(META.pushPermissionAskedAt, now.toISOString());
  // One sentence of context before the system prompt (Android 13+ asks once).
  if (!(await askContext())) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Queues the token unless it is already registered or already waiting to be. */
export async function enqueueToken(token: string): Promise<PushResult> {
  if (token === (await readPushToken())) return 'unchanged';
  const waiting = [...(await listByState('pending')), ...(await listByState('sending'))].some(
    (item) =>
      item.lane === 'device_register' &&
      DeviceBody.safeParse(JSON.parse(item.body)).data?.pushToken === token,
  );
  if (waiting) return 'unchanged';
  await enqueue({
    lane: 'device_register',
    method: lane.method,
    path: lane.path,
    body: { platform: 'android', pushToken: token },
  });
  return 'enqueued';
}

/**
 * Runs after the shell is visible, on first sign-in and on every app open. Never throws: a push
 * failure must not break the app.
 */
export async function registerForPush(
  askContext: () => Promise<boolean>,
  now: Date = new Date(),
): Promise<PushResult> {
  if (!pushEnabled()) {
    log('info', 'push.skipped', { reason: 'no_firebase' });
    return 'skipped_no_firebase';
  }
  try {
    if (!(await permissionGranted(askContext, now))) {
      log('info', 'push.skipped', { reason: 'permission_denied' });
      return 'skipped_permission';
    }
    const token: unknown = (await Notifications.getDevicePushTokenAsync()).data;
    if (typeof token !== 'string' || token === '') return 'failed';
    return await enqueueToken(token);
  } catch (error) {
    log('warn', 'push.failed', errorFields(error));
    return 'failed';
  }
}

/** The outbox's follow-up when device_register reaches the server: remember the token. */
export async function onDeviceRegistered(item: OutboxItem): Promise<void> {
  if (item.lane !== 'device_register') return;
  const body = DeviceBody.safeParse(JSON.parse(item.body));
  if (body.success) await writePushToken(body.data.pushToken);
}

/** FCM rotates tokens: a refresh is queued like a first registration. */
export function listenForTokenRefresh(onEnqueued: () => void): () => void {
  if (!pushEnabled()) return () => undefined;
  const subscription = Notifications.addPushTokenListener((token) => {
    void enqueueToken(String(token.data)).then((result) => {
      if (result === 'enqueued') onEnqueued();
    });
  });
  return () => subscription.remove();
}

/** Banners while the app is open, no sound; nothing is kept on the device beyond the OS tray. */
export function configureForegroundDisplay(): void {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
  });
}

/** Taps, including the one that cold-started the app (read once). */
export function listenForTaps(
  hasScreen: (tab: TabId) => boolean,
  open: (route: string) => void,
): () => void {
  const route = (response: Notifications.NotificationResponse) =>
    open(routeForNotification(response.notification.request.content.data, hasScreen));
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response !== null) route(response);
  });
  const subscription = Notifications.addNotificationResponseReceivedListener(route);
  return () => subscription.remove();
}
