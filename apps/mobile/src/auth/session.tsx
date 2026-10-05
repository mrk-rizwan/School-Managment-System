import { ApiError, formatDate } from '@asms/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Alert, AppState } from 'react-native';
import {
  api,
  isNetworkError,
  onSessionLost,
  onUpgradeRequired,
  setBearerToken,
  unwrapWithDate,
  type UpgradeRequired,
} from '../api/client';
import type { MeDto } from '../api/contracts';
import { evictCache, readCache, writeCache, type Cached } from '../db/cache';
import { discardExpiredUnsent, getDb, wipeUnlessOwnedBy, type DiscardedItem } from '../db/database';
import { recoverWaitingAttachments, sweepPhotoFiles } from '../db/local.repository';
import { countUnsent, purgeFinished } from '../db/outbox.repository';
import { deleteCachedDownloads } from '../media/files';
import { startConnectivity, subscribeConnectivity } from '../net/connectivity';
import { laneOf } from '../outbox/lanes';
import { outboxWorker, recoverStaleItems } from '../outbox/runtime';
import { readAppVersion } from '../platform/app-version';
import { log } from '../platform/log';
import { errorFields } from '../platform/scrub';
import { registerForPush } from '../push/registration';
import { changePassword, logoutOnServer, type ChangePasswordResult } from './account';
import { forgetSchoolCode, forgetUsername, readSession } from './session-store';
import { ME_CACHE_KEY, signIn, type SignInInput, type SignInResult } from './sign-in';
import { loseSession, wipeAll } from './wipe';

// The session: the startup gate (slice-15 §4.1) and the state machine every screen reads.
//   starting → signed-out | signed-in | blocked | no-access | unreachable
// A 401 outside the login form → signed-out with the queue paused (§4.5); any 426 → blocked,
// where only the update screen renders (§11).

export type SessionStatus =
  'starting' | 'signed-out' | 'signed-in' | 'blocked' | 'no-access' | 'unreachable';

export type SessionState = {
  status: SessionStatus;
  me: Cached<MeDto> | null;
  upgrade: UpgradeRequired | null;
  /** Unsent outbox items kept for the same user's next sign-in (§7.6). */
  unsent: number;
  /** A 401 ended the session: the sign-in screen says so. */
  sessionEnded: boolean;
  /** Unsent items discarded because the session ended over seven days ago (§7.6), as a sentence. */
  discardedNotice: string | null;
  /** The last /me refresh did not reach the school: Home shows the offline notice. */
  meStale: boolean;
  /** The default-password banner was dismissed for this run of the app. */
  bannerDismissed: boolean;
};

export type SessionActions = {
  signIn: (input: SignInInput) => Promise<SignInResult>;
  /** Server first; `force` skips the server (the user chose "sign out anyway"). */
  signOut: (options?: { force?: boolean }) => Promise<'signed_out' | 'unreachable'>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<ChangePasswordResult>;
  refreshMe: () => Promise<void>;
  /** The update screen's "Check again". Returns a message when it could not tell. */
  checkAgain: () => Promise<string | null>;
  retryStartup: () => Promise<void>;
  forgetMe: () => Promise<void>;
  notMySchool: () => Promise<void>;
  discardUnsent: () => Promise<void>;
  dismissBanner: () => void;
  dismissDiscardedNotice: () => void;
};

const initial: SessionState = {
  status: 'starting',
  me: null,
  upgrade: null,
  unsent: 0,
  sessionEnded: false,
  discardedNotice: null,
  meStale: false,
  bannerDismissed: false,
};

/** "2 unsent items were discarded because your session ended: Notification registration (4 Oct 2026)." */
export function describeDiscarded(items: DiscardedItem[]): string | null {
  if (items.length === 0) return null;
  const what = [
    ...new Set(
      items.map(
        (item) => `${laneOf(item.lane)?.label ?? item.lane} (${formatDate(item.createdAt)})`,
      ),
    ),
  ].join(', ');
  const count = `${items.length} unsent ${items.length === 1 ? 'item was' : 'items were'}`;
  return `${count} discarded because your session ended: ${what}.`;
}

const SessionContext = createContext<(SessionState & SessionActions) | null>(null);

export function useSession(): SessionState & SessionActions {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession outside SessionProvider');
  return value;
}

/** One sentence of context before Android's notification prompt (slice-15 §8). */
function askNotificationContext(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Notifications',
      'The school sends attendance alerts, diary entries and notices to this phone.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function SessionProvider({
  children,
  registerPush = registerForPush,
}: {
  children: ReactNode;
  /** Replaceable in tests. */
  registerPush?: typeof registerForPush;
}) {
  const [state, setState] = useState<SessionState>(initial);
  const statusRef = useRef<SessionStatus>('starting');
  const pushStarted = useRef(false);
  const losing = useRef(false);

  const update = useCallback((patch: Partial<SessionState>) => {
    setState((previous) => {
      const next = { ...previous, ...patch };
      statusRef.current = next.status;
      return next;
    });
  }, []);

  const enter = useCallback(
    (me: Cached<MeDto>, meStale = false) => {
      if (me.body.capacities.length === 0) {
        // R156: defensive — the API refuses such a login; a capacity lost mid-session lands here.
        outboxWorker.stop();
        update({ status: 'no-access', me, meStale });
        return;
      }
      update({ status: 'signed-in', me, meStale, upgrade: null, sessionEnded: false, unsent: 0 });
      // §7.6: before the queue runs again, writes left by a session lost over seven days ago go.
      void discardExpiredUnsent(new Date(), true).then(
        (discarded) => {
          const notice = describeDiscarded(discarded);
          if (notice !== null) update({ discardedNotice: notice });
          if (statusRef.current !== 'signed-in') return; // lost again meanwhile
          outboxWorker.resume();
          void outboxWorker.trigger('sign_in');
        },
        (error: unknown) => log('error', 'outbox.discard_check_failed', errorFields(error)),
      );
      if (!pushStarted.current) {
        pushStarted.current = true;
        void registerPush(askNotificationContext).then((result) => {
          if (result === 'enqueued') void outboxWorker.trigger('enqueued');
        });
      }
    },
    [registerPush, update],
  );

  /** GET /me. 401 and 426 are handled by the client listeners. */
  const fetchMe = useCallback(
    async (hasCache: boolean): Promise<void> => {
      try {
        const { data, date } = await unwrapWithDate(api.GET('/api/v1/me'));
        enter(await writeCache(ME_CACHE_KEY, data, date));
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 426)) return;
        // Not reaching the school is ordinary; any other failure is a fault worth seeing.
        log(isNetworkError(error) ? 'info' : 'error', 'session.me_refresh_failed', errorFields(error));
        if (hasCache) update({ meStale: true });
        else update({ status: 'unreachable' });
      }
    },
    [enter, update],
  );

  const start = useCallback(async () => {
    readAppVersion(); // a malformed build version fails here, not with a 426 in the field
    await getDb();
    const now = new Date();
    // In sequence: purgeFinished writes on its own (exclusive) connection, the others on the main
    // one, and two writers at once only wait on each other's lock.
    await evictCache(now);
    await purgeFinished(now);
    await recoverStaleItems(now);
    // Slice 16 §4.5, §13.3: photos left waiting by a crash, files no row points at, downloads.
    await recoverWaitingAttachments(now);
    await sweepPhotoFiles();
    deleteCachedDownloads();
    const notice = describeDiscarded(await discardExpiredUnsent(now));
    if (notice !== null) update({ discardedNotice: notice });
    const stored = await readSession();
    if (stored === null) {
      update({ status: 'signed-out', unsent: await countUnsent() });
      return;
    }
    await wipeUnlessOwnedBy(stored.userId, stored.schoolId);
    setBearerToken(stored.token);
    const cached = await readCache<MeDto>(ME_CACHE_KEY);
    if (cached !== null) enter(cached, true);
    await fetchMe(cached !== null);
  }, [enter, fetchMe, update]);

  useEffect(() => {
    void start().catch((error: unknown) => {
      log('error', 'session.start_failed', errorFields(error));
      update({ status: 'unreachable' });
    });
  }, [start, update]);

  useEffect(() => {
    const offLost = onSessionLost(() => {
      if (losing.current || statusRef.current === 'signed-out') return;
      losing.current = true;
      // The next sign-in, even the same user's, registers the push token again (review L2).
      pushStarted.current = false;
      void loseSession()
        .then((kept) =>
          update({
            status: 'signed-out',
            me: null,
            unsent: kept,
            sessionEnded: true,
            meStale: false,
          }),
        )
        .finally(() => {
          losing.current = false;
        });
    });
    const offUpgrade = onUpgradeRequired((upgrade) => {
      outboxWorker.block();
      update({ status: 'blocked', upgrade });
    });
    startConnectivity();
    const offOnline = subscribeConnectivity((online) => {
      if (online) void outboxWorker.trigger('online');
    });
    const appState = AppState.addEventListener('change', (next) => {
      const foreground = next === 'active';
      outboxWorker.setForeground(foreground);
      if (foreground) void outboxWorker.trigger('foreground');
    });
    return () => {
      offLost();
      offUpgrade();
      offOnline();
      appState.remove();
    };
  }, [update]);

  const actions = useMemo<SessionActions>(
    () => ({
      async signIn(input) {
        const result = await signIn(input);
        if (result.ok) enter(result.me);
        return result;
      },
      async signOut(options) {
        if (!options?.force && !(await logoutOnServer())) return 'unreachable';
        await wipeAll();
        pushStarted.current = false;
        update({
          status: 'signed-out',
          me: null,
          unsent: 0,
          sessionEnded: false,
          meStale: false,
          bannerDismissed: false,
        });
        return 'signed_out';
      },
      async changePassword(currentPassword, newPassword) {
        const result = await changePassword(currentPassword, newPassword);
        if (result.ok) update({ me: result.me, meStale: false });
        return result;
      },
      refreshMe: () => fetchMe(true),
      async checkAgain() {
        const stored = await readSession();
        setBearerToken(stored?.token ?? null);
        try {
          const { data, date } = await unwrapWithDate(api.GET('/api/v1/me'));
          enter(await writeCache(ME_CACHE_KEY, data, date));
          return null;
        } catch (error) {
          if (error instanceof ApiError && error.status === 426) return error.message;
          if (error instanceof ApiError && error.status === 401) {
            // The version passed (the floor is checked before the session): sign in again.
            outboxWorker.unblock();
            outboxWorker.pause();
            update({ status: 'signed-out', upgrade: null, unsent: await countUnsent() });
            return null;
          }
          if (isNetworkError(error)) return 'Cannot reach the school. Check your connection.';
          log('error', 'session.check_again_failed', errorFields(error));
          return 'Something went wrong. Try again.';
        }
      },
      async retryStartup() {
        update({ status: 'starting' });
        await start().catch(() => update({ status: 'unreachable' }));
      },
      async forgetMe() {
        await forgetUsername();
        await wipeAll();
        update({ unsent: 0, sessionEnded: false });
      },
      async notMySchool() {
        await forgetSchoolCode();
      },
      async discardUnsent() {
        await wipeAll();
        update({ unsent: 0 });
      },
      dismissBanner() {
        update({ bannerDismissed: true });
      },
      dismissDiscardedNotice() {
        update({ discardedNotice: null });
      },
    }),
    [enter, fetchMe, start, update],
  );

  const value = useMemo(() => ({ ...state, ...actions }), [state, actions]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
