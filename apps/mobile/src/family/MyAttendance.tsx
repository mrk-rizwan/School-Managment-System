import { todayInSchool } from '@asms/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { MyStaffAttendanceDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { AttendanceMonth } from '../ui/AttendanceMonth';
import { ListRow } from '../ui/ListRow';
import { MonthHeader } from '../ui/MonthHeader';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { AsOf, NoDataState, OfflineNotice } from '../ui/states';
import { colors, fontSize } from '../ui/theme';
import { attendanceMonth } from './FamilyScreens';

// A staff member's own attendance (slice-16 §6, R135): the Home card and /home/my-attendance.
// The DTO has no note and no marker's name (slice-12 decision 6); neither is rendered. The
// user's own data: not secure.

function useStaffMonth(offset: number) {
  const month = attendanceMonth(todayInSchool(), offset);
  const query = useCachedQuery<MyStaffAttendanceDto>(
    queryKeys.staffAttendance(month.dateFrom, month.dateTo),
    '/api/v1/me/staff/attendance',
    { dateFrom: month.dateFrom, dateTo: month.dateTo },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/me/staff/attendance', {
          params: { query: { dateFrom: month.dateFrom, dateTo: month.dateTo } },
        }),
      ),
  );
  return { month, query };
}

/** "October: 18 of 20 working days" — present and late days of the working days so far. */
export function staffCardLine(title: string, data: MyStaffAttendanceDto): string {
  const monthName = title.split(' ')[0];
  return `${monthName}: ${data.present + data.late} of ${data.workingDays} working days`;
}

export function MyAttendanceCard() {
  const router = useRouter();
  const { month, query } = useStaffMonth(0);
  const data = query.data?.body;
  return (
    <Sheet testID="home.myAttendance">
      <ListRow
        title="My attendance"
        detail={
          data
            ? staffCardLine(month.title, data)
            : query.isError
              ? 'Not on this phone yet'
              : 'Loading…'
        }
        onPress={() => router.push('/home/my-attendance')}
        testID="home.myAttendance.open"
      />
    </Sheet>
  );
}

export function MyAttendanceScreen() {
  const online = useOnline();
  const [offset, setOffset] = useState(0);
  const { month, query } = useStaffMonth(offset);
  const cached = query.data;
  return (
    <Screen
      title="My attendance"
      banner={
        cached !== undefined && (!online || query.isError) ? (
          <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        ) : null
      }
      testID="myAttendance.screen"
    >
      <MonthHeader
        title={month.title}
        onPrevious={() => setOffset(offset - 1)}
        onNext={() => setOffset(offset + 1)}
        nextDisabled={offset >= 0}
        testID="myAttendance"
      />
      {cached === undefined ? (
        <NoDataState
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          offlineMessage="This month is not on this phone yet."
        />
      ) : (
        <>
          <AsOf serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
          <AttendanceMonth kind="staff" data={cached.body} testID="myAttendance.month" />
          <Text style={styles.caption}>Marked by the office. Ask the office about a mistake.</Text>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
