import { formatDay, todayInSchool } from '@asms/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../../api/client';
import type { MyCalendarDto } from '../../api/contracts';
import { queryKeys } from '../../api/query-keys';
import { useCachedQuery } from '../../db/use-cached-query';
import { useOnline } from '../../net/connectivity';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import {
  AsOf,
  EmptyState,
  ErrorState,
  LoadingState,
  NoPermissionState,
  OfflineNotice,
} from '../../ui/states';
import { SyncChip } from '../../ui/SyncChip';
import { colors, fontSize, space } from '../../ui/theme';
import { monthRange } from '../../platform/dates';

// GET /me/calendar (slice 10) — slice 15's read screen, proving the cache and "as of": one month
// at a time, cached per month, shown offline with the time it was fetched.

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export default function CalendarScreen() {
  const [offset, setOffset] = useState(0);
  const online = useOnline();
  const { dateFrom, dateTo, title } = monthRange(todayInSchool(), offset);
  const query = useCachedQuery<MyCalendarDto>(
    queryKeys.calendar(dateFrom, dateTo),
    '/api/v1/me/calendar',
    { dateFrom, dateTo },
    () =>
      unwrapWithDate(api.GET('/api/v1/me/calendar', { params: { query: { dateFrom, dateTo } } })),
  );
  const cached = query.data;

  let content;
  if (cached === undefined) {
    if (query.isError) {
      const status = (query.error as { status?: number }).status;
      content =
        status === 403 ? (
          <NoPermissionState />
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        );
    } else content = <LoadingState />;
  } else {
    const calendar = cached.body;
    const offDays = calendar.weeklyOffDays.map((day) => WEEKDAY_NAMES[day]).join(', ');
    content = (
      <View style={styles.body}>
        <AsOf serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        <Text style={styles.detail} testID="calendar.weeklyOff">
          {offDays === '' ? 'No weekly off days.' : `Weekly off: ${offDays}`}
        </Text>
        {calendar.holidays.length === 0 ? (
          <EmptyState title="No holidays this month" />
        ) : (
          <Sheet title="Holidays">
            {calendar.holidays.map((holiday) => (
              <ListRow
                key={`${holiday.startsOn}-${holiday.name}`}
                title={holiday.name}
                detail={
                  holiday.startsOn === holiday.endsOn
                    ? formatDay(holiday.startsOn)
                    : `${formatDay(holiday.startsOn)} – ${formatDay(holiday.endsOn)}`
                }
                value={holiday.kind === 'public' ? 'Public' : 'School'}
              />
            ))}
          </Sheet>
        )}
      </View>
    );
  }

  return (
    <Screen
      title="Calendar"
      accessory={<SyncChip />}
      banner={
        cached !== undefined && (!online || query.isError) ? (
          <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        ) : null
      }
      testID="calendar.screen"
    >
      <View style={styles.month}>
        <Button
          label="Previous"
          variant="secondary"
          onPress={() => setOffset(offset - 1)}
          testID="calendar.previous"
        />
        <Text style={styles.monthTitle} testID="calendar.month">
          {title}
        </Text>
        <Button
          label="Next"
          variant="secondary"
          onPress={() => setOffset(offset + 1)}
          testID="calendar.next"
        />
      </View>
      {content}
    </Screen>
  );
}

const styles = StyleSheet.create({
  month: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  monthTitle: {
    fontSize: fontSize.title,
    fontWeight: '600',
    color: colors.foreground,
    flexShrink: 1,
  },
  body: { gap: space.md },
  detail: { fontSize: fontSize.small, color: colors.foreground },
});
