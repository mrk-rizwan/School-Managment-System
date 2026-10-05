import { Capability, formatDateTime } from '@asms/shared';

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { AnnouncementDto, MessagingUsageDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { holds } from '../auth/capabilities';
import { useSession } from '../auth/session';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { Button } from '../ui/Button';
import { ListRow } from '../ui/ListRow';
import { Paging } from '../ui/Paging';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { AsOf, cachedOfflineBanner, EmptyState, NoDataState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import { sendFailure, statusWord, usageLine, useSendAnnouncement } from './announce-model';

// Announce — /announce (slice-16 §7.2): the SMS usage card (only with school.settings.manage,
// the route's capability), "New announcement", and the school's recent announcements. A draft
// left by a failure between create and send is sent from here. No names: not secure.

const LIMIT = 25;
type Page<T> = { data: T[]; page: number; limit: number; total: number };

export function AnnounceScreen() {
  const router = useRouter();

  const online = useOnline();
  const { gate: sendGate, send: sendAnnouncement } = useSendAnnouncement();
  const { me } = useSession();
  const [page, setPage] = useState(1);
  const [sending, setSending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const showUsage = me !== null && holds(me.body, Capability.SCHOOL_SETTINGS_MANAGE);

  const usage = useCachedQuery<MessagingUsageDto>(
    queryKeys.messagingUsage,
    '/api/v1/messaging/usage',
    {},
    () => unwrapWithDate(api.GET('/api/v1/messaging/usage')),
    { enabled: showUsage },
  );
  const list = useCachedQuery<Page<AnnouncementDto>>(
    queryKeys.announcements(page),
    '/api/v1/announcements',
    { limit: LIMIT, page, sort: '-createdAt' },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/announcements', {
          params: { query: { limit: LIMIT, page, sort: '-createdAt' } },
        }),
      ),
  );

  async function sendDraft(id: string) {
    setSending(id);
    setMessage(null);
    try {
      await sendAnnouncement(id);
    } catch (error) {
      setMessage(sendFailure(error, true).message);
    } finally {
      setSending(null);
    }
  }

  const cached = list.data;
  return (
    <Screen
      title="Announce"
      testID="announce.screen"
      banner={cachedOfflineBanner(cached, online, list.isError)}
      onRefresh={() => {
        void list.refetch();
        if (showUsage) void usage.refetch();
      }}
    >
      {showUsage && usage.data !== undefined ? (
        <Sheet testID="announce.usage">
          <Text style={styles.body}>{usageLine(usage.data.body)}</Text>
          <AsOf serverTime={usage.data.serverTime} isDevice={usage.data.serverTimeIsDevice} />
        </Sheet>
      ) : null}
      <Button
        label="New announcement"
        onPress={() => router.push('/announce/new')}
        testID="announce.new"
      />
      {message ? <Text style={styles.error}>{message}</Text> : null}
      <Sheet title="Recent" testID="announce.list">
        {cached === undefined ? (
          <NoDataState
            isError={list.isError}
            error={list.error}
            onRetry={() => void list.refetch()}
            offlineMessage="The announcements are not on this phone yet."
          />
        ) : cached.body.data.length === 0 ? (
          <EmptyState title="No announcements yet." />
        ) : (
          <>
            {cached.body.data.map((a) => (
              <View key={a.id} testID={`announce.row.${a.id}`}>
                <ListRow
                  title={a.title}
                  detail={
                    a.sentAt
                      ? `Sent ${formatDateTime(a.sentAt)} · ${a.recipientCount} people`
                      : `Created ${formatDateTime(a.createdAt)}`
                  }
                  value={statusWord(a)}
                  onPress={() => router.push({ pathname: '/announce/[id]', params: { id: a.id } })}
                  testID={`announce.open.${a.id}`}
                />
                {a.status === 'draft' ? (
                  <View style={styles.draft}>
                    <Button
                      label="Send"
                      variant="secondary"
                      disabled={!sendGate.enabled}
                      busy={sending === a.id}
                      onPress={() => void sendDraft(a.id)}
                      testID={`announce.sendDraft.${a.id}`}
                    />
                    {sendGate.reason ? <Text style={styles.note}>{sendGate.reason}</Text> : null}
                  </View>
                ) : null}
              </View>
            ))}
            <Paging
              page={page}
              limit={LIMIT}
              total={cached.body.total}
              onPage={setPage}
              testID="announce.list"
            />
          </>
        )}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: fontSize.body, color: colors.foreground },
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
  draft: { gap: space.xs, paddingVertical: space.sm },
});
