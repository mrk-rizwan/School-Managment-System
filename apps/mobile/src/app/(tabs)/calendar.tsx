import { formatDay, todayInSchool } from '@asms/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../../api/client';
import type { MyCalendarDto } from '../../api/contracts';
import { queryKeys } from '../../api/query-keys';
import { useCachedQuery } from '../../db/use-cached-query';
import { useOnline } from '../../net/connectivity';
import { ListRow } from '../../ui/ListRow';
import { MonthHeader } from '../../ui/MonthHeader';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import { AsOf, cachedOfflineBanner, EmptyState, NoDataState } from '../../ui/states';
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
    content = (
      <NoDataState
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
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
      banner={cachedOfflineBanner(cached, online, query.isError)}
      testID="calendar.screen"
    >
      <MonthHeader
        title={title}
        onPrevious={() => setOffset(offset - 1)}
        onNext={() => setOffset(offset + 1)}
        testID="calendar"
      />
      {content}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.md },
  detail: { fontSize: fontSize.small, color: colors.foreground },
});
