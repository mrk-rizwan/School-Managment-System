import NetInfo from '@react-native-community/netinfo';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { MeDto } from '../api/contracts';
import { queryClient } from '../api/query-client';
import { SessionProvider, useSession } from '../auth/session';
import { writeSession } from '../auth/session-store';
import { ME_CACHE_KEY } from '../auth/sign-in';
import { writeCache } from '../db/cache';
import { bindOwner } from '../db/database';
import { startConnectivity, stopConnectivity } from '../net/connectivity';
import { outboxWorker } from '../outbox/runtime';
import { installFakeApi, SERVER_DATE, type FakeApi, type Handler } from './fake-api';

// Screen tests (slice-16 §15.1): the real session, database, outbox worker and client, a signed-in
// user from a /me fixture, and the fake API behind fetch. Only the network and the native modules
// are replaced.

export const TOKEN = 'T'.repeat(43);

let session: ReturnType<typeof useSession> | null = null;
function Probe() {
  session = useSession();
  return null;
}
export const currentSession = () => session!;

/** Signs `me` in on the device (secure store, owner, cached /me) and renders `ui` under it. */
export async function renderSignedIn(
  ui: ReactElement,
  me: MeDto,
  routes: Record<string, Handler> = {},
): Promise<{ fake: FakeApi; view: ReturnType<typeof render> }> {
  const fake = installFakeApi({ 'GET /api/v1/me': () => ({ status: 200, body: me }), ...routes });
  await writeSession({ token: TOKEN, userId: me.id, schoolId: me.school.id });
  await bindOwner(me.id, me.school.id);
  await writeCache(ME_CACHE_KEY, me, SERVER_DATE);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider registerPush={() => Promise.resolve('skipped_no_firebase' as const)}>
        <Probe />
        {ui}
      </SessionProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(currentSession().status).toBe('signed-in'));
  return { fake, view };
}

/** Flips the connectivity flag as NetInfo would. */
export function setOnline(online: boolean): void {
  stopConnectivity();
  startConnectivity();
  const calls = (NetInfo.addEventListener as jest.Mock).mock.calls;
  const listener = calls[calls.length - 1]?.[0] as
    ((state: { isConnected: boolean; isInternetReachable: boolean }) => void) | undefined;
  act(() => listener?.({ isConnected: online, isInternetReachable: online }));
}

/** Lets the outbox finish what it is sending. */
export async function settleOutbox(): Promise<void> {
  await act(async () => {
    await outboxWorker.trigger('retry_now');
    await outboxWorker.idle();
  });
}

/**
 * Polls `check` until it passes (8 s), letting real time and React updates run between tries.
 * For screens with an open modal, where waitFor's polling starves the fetch it waits on.
 */
export async function eventually(
  check: () => void | Promise<void>,
  timeoutMs = 8000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
  }
}
