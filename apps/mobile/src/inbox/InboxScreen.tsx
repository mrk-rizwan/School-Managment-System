import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { InboxItemDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { Paging } from '../ui/Paging';
import { RefreshableList } from '../ui/RefreshableList';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { AsOf, EmptyState, NoDataState, OfflineNotice } from '../ui/states';
import { colors, fontSize, radius, space, statusColors, TAP_TARGET } from '../ui/theme';
import { attachmentWord, CATEGORY_CHIPS, INBOX_LIMIT, sentLabel, viaLabel } from './inbox-model';

// Inbox — /inbox (slice-16 §7.3, slice-14 §7.3): every message the school sent this person,
// newest first, cached with its "as of". One filter, the category. No image loads here (R160).
// `secure` when the user is a guardian: rows name their children.

type Page<T> = { data: T[]; page: number; limit: number; total: number };
type Category = (typeof CATEGORY_CHIPS)[number]['value'];

export function InboxScreen({ secure }: { secure: boolean }) {
  const router = useRouter();
  const online = useOnline();
  const [category, setCategory] = useState<Category>('all');
  const [page, setPage] = useState(1);
  const query = useCachedQuery<Page<InboxItemDto>>(
    queryKeys.inbox(category, page),
    '/api/v1/me/inbox',
    { limit: INBOX_LIMIT, page, category: category === 'all' ? undefined : category },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/me/inbox', {
          params: {
            query: {
              limit: INBOX_LIMIT,
              page,
              ...(category === 'all' ? {} : { category }),
            },
          },
        }),
      ),
  );
  const cached = query.data;

  const header = (
    <View style={styles.header}>
      <SegmentedPicker
        label="Show"
        options={CATEGORY_CHIPS}
        value={category}
        onChange={(value) => {
          setCategory(value);
          setPage(1);
        }}
        testID="inbox.category"
      />
      {cached ? <AsOf serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} /> : null}
    </View>
  );

  return (
    <Screen
      title="Inbox"
      secure={secure}
      scroll={false}
      testID="inbox.screen"
      banner={
        cached !== undefined && (!online || query.isError) ? (
          <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        ) : null
      }
    >
      {cached === undefined ? (
        <>
          {header}
          <NoDataState
            isError={query.isError}
            error={query.error}
            onRetry={() => void query.refetch()}
            offlineMessage="Messages are not on this phone yet."
          />
        </>
      ) : (
        <RefreshableList
          data={cached.body.data}
          keyExtractor={(item) => item.id}
          online={online}
          refreshing={false}
          onRefresh={() => void query.refetch()}
          header={header}
          empty={<EmptyState title="Nothing from the school yet." />}
          testID="inbox.list"
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/inbox/[id]', params: { id: item.id } })}
              style={[styles.row, item.priority === 'urgent' && styles.urgent]}
              testID={`inbox.row.${item.id}`}
            >
              <View style={styles.titleLine}>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.caption}>{sentLabel(item.sentAt)}</Text>
              </View>
              <View style={styles.chips}>
                {item.priority === 'urgent' ? <Text style={styles.badge}>Urgent</Text> : null}
                {item.viaStudents.map((s) => (
                  <Text key={s.studentId} style={styles.chip}>
                    {viaLabel(s.fullName)}
                  </Text>
                ))}
                {attachmentWord(item.attachmentMime) ? (
                  <Text style={styles.chip}>{attachmentWord(item.attachmentMime)}</Text>
                ) : null}
              </View>
            </Pressable>
          )}
        />
      )}
      {cached !== undefined ? (
        <Paging
          page={page}
          limit={INBOX_LIMIT}
          total={cached.body.total}
          onPage={setPage}
          testID="inbox.list"
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.sm, paddingBottom: space.sm },
  row: {
    minHeight: TAP_TARGET,
    paddingVertical: space.md,
    paddingLeft: space.sm,
    gap: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  // Concept slide 05: an urgent item carries the red edge (and the word, never colour alone).
  urgent: { borderLeftColor: statusColors.absent },
  titleLine: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  title: { flex: 1, fontSize: fontSize.body, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    fontSize: fontSize.caption,
    color: colors.foreground,
    backgroundColor: colors.muted,
    borderRadius: radius,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  badge: {
    fontSize: fontSize.caption,
    color: statusColors.onStatus,
    backgroundColor: statusColors.absent,
    borderRadius: radius,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
});
