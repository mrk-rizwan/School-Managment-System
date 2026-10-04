import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useSyncExternalStore } from 'react';

// The only reader of NetInfo (lint): one boolean and a subscription (slice-15 §7.5). Offline is a
// banner state, not an error state. The outbox never trusts the flag alone: when it says online a
// request is attempted and the outcome decides.

let online = true;
const listeners = new Set<(online: boolean) => void>();
let unsubscribe: (() => void) | null = null;

export function isOfflineState(
  state: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>,
): boolean {
  return state.isConnected === false || state.isInternetReachable === false;
}

export const isOnline = (): boolean => online;

export function subscribeConnectivity(listener: (online: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Starts listening; idempotent. */
export function startConnectivity(): void {
  if (unsubscribe !== null) return;
  unsubscribe = NetInfo.addEventListener((state) => {
    const next = !isOfflineState(state);
    if (next === online) return;
    online = next;
    for (const listener of listeners) listener(online);
  });
}

export function stopConnectivity(): void {
  unsubscribe?.();
  unsubscribe = null;
}

/** The connectivity flag as React state, for the offline banner and online-only buttons. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeConnectivity, isOnline);
}
