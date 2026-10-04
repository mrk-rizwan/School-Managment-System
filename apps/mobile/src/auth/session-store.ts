import * as SecureStore from 'expo-secure-store';

// The ONLY importer of expo-secure-store (lint), and the whole key list (slice-15 §4.3). Nothing
// else on the device persists any of these; AsyncStorage is not installed. The password is never
// stored anywhere.

export const KEYS = {
  token: 'asms.session.token',
  userId: 'asms.session.userId',
  schoolId: 'asms.session.schoolId',
  schoolCode: 'asms.remembered.schoolCode',
  username: 'asms.remembered.username',
  pushToken: 'asms.push.token',
  /** Set when a wipe could not close the database: the next open deletes the file first. */
  wipePending: 'asms.wipe.pending',
} as const;

/** Every key this app ever writes, so a wipe can be proven complete. */
export const ALL_KEYS: readonly string[] = Object.values(KEYS);

export type StoredSession = { token: string; userId: string; schoolId: string };

export async function readSession(): Promise<StoredSession | null> {
  const [token, userId, schoolId] = await Promise.all([
    SecureStore.getItemAsync(KEYS.token),
    SecureStore.getItemAsync(KEYS.userId),
    SecureStore.getItemAsync(KEYS.schoolId),
  ]);
  if (token === null || userId === null || schoolId === null) return null;
  return { token, userId, schoolId };
}

export async function writeSession(session: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(KEYS.token, session.token);
  await SecureStore.setItemAsync(KEYS.userId, session.userId);
  await SecureStore.setItemAsync(KEYS.schoolId, session.schoolId);
}

/** Replaces the token alone: the change-password rotation (slice-9 §3.4). */
export async function replaceToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.token, token);
}

/** Removes the token, the session ids and the registered push token. */
export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.token);
  await SecureStore.deleteItemAsync(KEYS.userId);
  await SecureStore.deleteItemAsync(KEYS.schoolId);
  await SecureStore.deleteItemAsync(KEYS.pushToken);
}

export type Remembered = { schoolCode: string | null; username: string | null };

export async function readRemembered(): Promise<Remembered> {
  const [schoolCode, username] = await Promise.all([
    SecureStore.getItemAsync(KEYS.schoolCode),
    SecureStore.getItemAsync(KEYS.username),
  ]);
  return { schoolCode, username };
}

export async function remember(schoolCode: string, username: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.schoolCode, schoolCode);
  await SecureStore.setItemAsync(KEYS.username, username);
}

/** "Not your school?" */
export async function forgetSchoolCode(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.schoolCode);
}

/** "Forget me." */
export async function forgetUsername(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.username);
}

export const readPushToken = () => SecureStore.getItemAsync(KEYS.pushToken);

export async function writePushToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.pushToken, token);
}

export async function clearPushToken(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.pushToken);
}

/** A wipe that could not finish (the database would not close): retried at the next open. */
export async function markWipePending(): Promise<void> {
  await SecureStore.setItemAsync(KEYS.wipePending, '1');
}

export async function isWipePending(): Promise<boolean> {
  return (await SecureStore.getItemAsync(KEYS.wipePending)) !== null;
}

export async function clearWipePending(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.wipePending);
}
