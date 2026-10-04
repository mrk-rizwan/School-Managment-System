import { formatDateTime } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { InboxItemDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import { composeTabs } from '../auth/tabs';
import type { Cached } from '../db/cache';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { Attachment } from '../ui/Attachment';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { AsOf, NoDataState, OfflineNotice } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import { CATEGORY_CHIPS, childScreenOf, sentLabel } from './inbox-model';

// One message — /inbox/[id] (slice-16 §7.3, slice-14 §7.4). Opened from the list it uses the
// row already on the phone; from a push it reads GET /me/inbox/:id. "Open <child>" goes to the
// child's attendance, diary or remarks by message type. The attachment loads only on a tap
// (R160). Nothing is recorded about the opening (R150).

type Page = { data: InboxItemDto[] };

/** The row from any inbox page already in memory, so a tap from the list costs no request. */
function useListedItem(id: string): Cached<InboxItemDto> | undefined {
  const client = useQueryClient();
  for (const [, page] of client.getQueriesData<Cached<Page>>({ queryKey: ['me', 'inbox'] })) {
    const item = page?.body.data?.find((row) => row.id === id);
    if (item !== undefined && page !== undefined) return { ...page, body: item };
  }
  return undefined;
}

export function InboxItemScreen({ id, secure }: { id: string; secure: boolean }) {
  const router = useRouter();
  const online = useOnline();
  const { me } = useSession();
  const listed = useListedItem(id);
  const fetched = useCachedQuery<InboxItemDto>(
    queryKeys.inboxItem(id),
    `/api/v1/me/inbox/${id}`,
    {},
    () => unwrapWithDate(api.GET('/api/v1/me/inbox/{id}', { params: { path: { id } } })),
    { enabled: listed === undefined },
  );
  const cached = listed ?? fetched.data;
  if (cached === undefined) {
    return (
      <Screen title="Message" secure={secure} testID="inboxItem.screen">
        <NoDataState
          isError={fetched.isError}
          error={fetched.error}
          onRetry={() => void fetched.refetch()}
          offlineMessage="This message is not on this phone yet."
        />
      </Screen>
    );
  }
  const item = cached.body;
  const hasChildren = me !== null && composeTabs(me.body).includes('children');
  const target = childScreenOf(item.messageType);
  const category = CATEGORY_CHIPS.find((c) => c.value === item.category)?.label;

  return (
    <Screen
      title={item.title}
      secure={secure}
      testID="inboxItem.screen"
      banner={
        listed === undefined && (!online || fetched.isError) ? (
          <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        ) : null
      }
    >
      <Text style={styles.caption} testID="inboxItem.meta">
        {[
          item.priority === 'urgent' ? 'Urgent' : null,
          category ?? null,
          `Sent ${sentLabel(item.sentAt)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      <Text selectable style={styles.body} testID="inboxItem.body">
        {item.body}
      </Text>
      {item.hasAttachment ? (
        <Attachment
          basePath={`/api/v1/me/inbox/${item.id}`}
          mime={item.attachmentMime}
          sizeBytes={null}
          online={online}
          label="Attachment"
        />
      ) : null}
      {hasChildren && target !== null && item.viaStudents.length > 0 ? (
        <View style={styles.children}>
          {item.viaStudents.map((child) => (
            <Button
              key={child.studentId}
              label={`Open ${child.fullName}`}
              variant="secondary"
              onPress={() =>
                router.push({
                  pathname: `/children/[studentId]/${target}`,
                  params: { studentId: child.studentId },
                })
              }
              testID={`inboxItem.open.${child.studentId}`}
            />
          ))}
        </View>
      ) : null}
      <AsOf serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
      <Text style={styles.caption}>{formatDateTime(item.sentAt)}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: fontSize.body, color: colors.foreground, lineHeight: 22 },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  children: { gap: space.sm },
});
