import { Capability, formatDay, todayInSchool } from '@asms/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { DailySummaryDto, SectionDayDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { holds, schoolWide } from '../auth/capabilities';
import { useSession } from '../auth/session';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Paging } from '../ui/Paging';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { AsOf, EmptyState, NoDataState, OfflineNotice } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize, space } from '../ui/theme';
import { CoverSheet } from './CoverSheet';
import {
  byClass,
  notTeachingDay,
  sectionLabel,
  summaryLine,
  unrecordedDetail,
} from './today-model';

// Today — /today (slice-16 §7.1): what was not recorded today and the day's summary, both
// cached with their "as of". Record now opens the register (offline-capable); Assign cover is
// online only. No student names: not secure.

const UNRECORDED_LIMIT = 25;
const SUMMARY_LIMIT = 50;

type Page<T> = { data: T[]; page: number; limit: number; total: number };

export function TodayScreen() {
  const router = useRouter();
  const online = useOnline();
  const coverGate = useOnlineOnly('assign_cover');
  const { me } = useSession();
  const today = todayInSchool();
  const [page, setPage] = useState(1);
  const [summaryPage, setSummaryPage] = useState(1);
  const [coverRow, setCoverRow] = useState<SectionDayDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const unrecorded = useCachedQuery<Page<SectionDayDto>>(
    queryKeys.unrecorded(today, page),
    '/api/v1/attendance-registers',
    { date: today, recorded: 'false', limit: UNRECORDED_LIMIT, page },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/attendance-registers', {
          params: { query: { date: today, recorded: false, limit: UNRECORDED_LIMIT, page } },
        }),
      ),
    // Live on the server: always refetched on open.
    { staleTime: 0 },
  );
  const summary = useCachedQuery<Page<DailySummaryDto>>(
    queryKeys.dailySummary(today, summaryPage),
    '/api/v1/attendance-reports/daily-summary',
    { dateFrom: today, dateTo: today, limit: SUMMARY_LIMIT, page: summaryPage },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/attendance-reports/daily-summary', {
          params: {
            query: { dateFrom: today, dateTo: today, limit: SUMMARY_LIMIT, page: summaryPage },
          },
        }),
      ),
  );

  if (me === null) return null;
  // MeDto.capabilityScopes (slice-14 §8): only a school-wide mark key writes any register.
  const canRecord = schoolWide(me.body, Capability.ATTENDANCE_STUDENT_MARK);
  const canCover =
    holds(me.body, Capability.CLASS_MANAGE) && holds(me.body, Capability.STAFF_VIEW);

  const cached = unrecorded.data ?? summary.data;
  const failed = unrecorded.isError || summary.isError;
  const summaryRows = summary.data?.body.data ?? [];
  const holiday = notTeachingDay(summaryRows);
  const list = unrecorded.data;

  const banner = (
    <View style={styles.banners}>
      {cached !== undefined && (!online || failed) ? (
        <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
      ) : null}
      {notice ? (
        <Banner text={notice} onDismiss={() => setNotice(null)} testID="today.notice" />
      ) : null}
    </View>
  );

  return (
    <Screen
      title="Today"
      accessory={<SyncChip />}
      banner={banner}
      testID="today.screen"
      refreshControl={
        <RefreshControl
          refreshing={false}
          enabled={online}
          onRefresh={() => {
            void unrecorded.refetch();
            void summary.refetch();
          }}
          colors={[colors.primary]}
        />
      }
    >
      <Text style={styles.date}>{formatDay(today)}</Text>
      <Sheet title="Not recorded" testID="today.unrecorded">
        {list === undefined ? (
          <NoDataState
            isError={unrecorded.isError}
            error={unrecorded.error}
            onRetry={() => void unrecorded.refetch()}
            offlineMessage="Today's registers are not on this phone yet."
          />
        ) : holiday ? (
          <EmptyState title="Not a teaching day." />
        ) : list.body.data.length === 0 ? (
          <EmptyState title="Every register is recorded." />
        ) : (
          <>
            <AsOf serverTime={list.serverTime} isDevice={list.serverTimeIsDevice} />
            {list.body.data.map((row) => (
              <View
                key={row.sectionId}
                style={styles.row}
                testID={`today.unrecorded.${row.sectionId}`}
              >
                <Text style={styles.title}>{sectionLabel(row)}</Text>
                {unrecordedDetail(row).map((line) => (
                  <Text key={line} style={styles.detail}>
                    {line}
                  </Text>
                ))}
                <View style={styles.actions}>
                  {canRecord ? (
                    <Button
                      label="Record now"
                      onPress={() =>
                        router.push({
                          pathname: '/today/[sectionId]/register',
                          params: { sectionId: row.sectionId, date: today, period: '1' },
                        })
                      }
                      testID={`today.recordNow.${row.sectionId}`}
                    />
                  ) : null}
                  {canCover ? (
                    <Button
                      label="Assign cover"
                      variant="secondary"
                      disabled={!coverGate.enabled}
                      onPress={() => setCoverRow(row)}
                      testID={`today.cover.${row.sectionId}`}
                    />
                  ) : null}
                </View>
                {canCover && coverGate.reason ? (
                  <Text style={styles.detail}>{coverGate.reason}</Text>
                ) : null}
              </View>
            ))}
            <Paging
              page={page}
              limit={UNRECORDED_LIMIT}
              total={list.body.total}
              onPage={setPage}
              testID="today.unrecorded"
            />
          </>
        )}
      </Sheet>

      <Sheet title="Summary" testID="today.summary">
        {summary.data === undefined ? (
          <NoDataState
            isError={summary.isError}
            error={summary.error}
            onRetry={() => void summary.refetch()}
            offlineMessage="Today's summary is not on this phone yet."
          />
        ) : summaryRows.length === 0 ? (
          <Text style={styles.detail}>Not yet computed.</Text>
        ) : (
          <>
            {byClass(summaryRows).map(([className, rows]) => (
              <View key={className} style={styles.group}>
                <Text style={styles.title}>{className}</Text>
                {rows.map((row) => (
                  <Text
                    key={row.sectionId}
                    style={styles.detail}
                    testID={`today.summary.${row.sectionId}`}
                  >
                    {summaryLine(row)}
                  </Text>
                ))}
              </View>
            ))}
            <Paging
              page={summaryPage}
              limit={SUMMARY_LIMIT}
              total={summary.data.body.total}
              onPage={setSummaryPage}
              testID="today.summary"
            />
          </>
        )}
      </Sheet>

      <CoverSheet
        row={coverRow}
        onClose={() => setCoverRow(null)}
        onDone={(message) => {
          setCoverRow(null);
          setNotice(message);
          // The row stays until a register exists: cover does not record.
          void unrecorded.refetch();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  banners: { gap: space.sm },
  date: { fontSize: fontSize.body, color: colors.mutedForeground },
  row: {
    gap: space.xs,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  group: { gap: space.xs, paddingVertical: space.sm },
  title: { fontSize: fontSize.body, fontWeight: '600', color: colors.foreground },
  detail: { fontSize: fontSize.small, color: colors.mutedForeground },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingTop: space.xs },
});
