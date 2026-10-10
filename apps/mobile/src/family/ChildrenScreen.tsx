import { todayInSchool } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MyChildDto, StudentAttendanceDto } from '../api/contracts';
import { useSession } from '../auth/session';
import { sectionTitle } from '../classes/my-classes';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { monthToDate } from '../platform/dates';
import { monthLine } from '../ui/AttendanceMonth';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { AsOf, EmptyState, LoadingState, OfflineNotice } from '../ui/states';
import { StatusChip } from '../ui/StatusChip';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize, space, statusTone } from '../ui/theme';
import { familyRead } from './source';

// Children — /children (slice-16 §5.1): one card per linked child with today's status and this
// month so far, one cached request per child (the same key the month view uses for this month).
// Secure: children's names.

const STATUS_BADGE: Partial<Record<MyChildDto['status'], string>> = {
  withdrawn: 'Left',
  transferred: 'Left',
  alumni: 'Left',
  suspended: 'Suspended',
};

export function todayLine(data: StudentAttendanceDto, today: string): string {
  const day = data.days.find((d) => d.date === today);
  if (day === undefined || !day.teachingDay) return 'No school today';
  if (day.status === null) return 'Not recorded yet';
  return statusTone(day.status).word;
}

function ChildCard({ child }: { child: MyChildDto }) {
  const router = useRouter();
  const today = todayInSchool();
  const read = familyRead(
    { kind: 'child', studentId: child.studentId },
    'attendance',
    monthToDate(today),
  );
  const query = useCachedQuery<StudentAttendanceDto>(read.key, read.path, read.params, read.fetch);
  const data = query.data?.body;
  const day = data?.days.find((d) => d.date === today);
  const open = (screen: 'attendance' | 'diary' | 'remarks' | 'fees' | 'results' | 'timetable') =>
    router.push({
      pathname: `/children/[studentId]/${screen}`,
      params: { studentId: child.studentId },
    });
  return (
    <Sheet testID={`children.card.${child.studentId}`}>
      <ListRow
        title={child.fullName}
        detail={
          child.current
            ? `${sectionTitle(child.current.className, child.current.sectionName)}${
                child.current.rollNo === null ? '' : ` · Roll ${child.current.rollNo}`
              }`
            : 'No current class'
        }
        value={STATUS_BADGE[child.status] ?? null}
        onPress={() => open('attendance')}
        testID={`children.card.${child.studentId}.open`}
      />
      {data === undefined ? (
        <Text style={styles.caption}>
          {query.isError ? 'Attendance not on this phone yet.' : 'Loading attendance…'}
        </Text>
      ) : (
        <View style={styles.today}>
          <StatusChip status={day?.teachingDay ? (day.status ?? null) : null} />
          <View style={styles.todayText}>
            <Text style={styles.body} testID={`children.card.${child.studentId}.today`}>
              {todayLine(data, today)}
            </Text>
            <Text style={styles.caption}>{`This month: ${monthLine(data)}`}</Text>
            {query.data ? (
              <AsOf serverTime={query.data.serverTime} isDevice={query.data.serverTimeIsDevice} />
            ) : null}
          </View>
        </View>
      )}
      <ListRow
        title="Diary"
        onPress={() => open('diary')}
        testID={`children.card.${child.studentId}.diary`}
      />
      <ListRow
        title="Remarks"
        onPress={() => open('remarks')}
        testID={`children.card.${child.studentId}.remarks`}
      />
      <ListRow
        title="Results"
        onPress={() => open('results')}
        testID={`children.card.${child.studentId}.results`}
      />
      <ListRow
        title="Timetable"
        onPress={() => open('timetable')}
        testID={`children.card.${child.studentId}.timetable`}
      />
      <ListRow
        title="Fees"
        onPress={() => open('fees')}
        testID={`children.card.${child.studentId}.fees`}
      />
    </Sheet>
  );
}

export function ChildrenScreen({ secure }: { secure?: boolean }) {
  const session = useSession();
  const online = useOnline();
  const client = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const me = session.me;
  if (me === null) return <LoadingState />;
  return (
    <Screen
      title="Children"
      accessory={<SyncChip />}
      secure={secure}
      banner={
        !online || session.meStale ? (
          <OfflineNotice serverTime={me.serverTime} isDevice={me.serverTimeIsDevice} />
        ) : null
      }
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void session
          .refreshMe()
          .then(() => client.invalidateQueries({ queryKey: ['me', 'children'] }))
          .finally(() => setRefreshing(false));
      }}
      testID="children.screen"
    >
      {me.body.children.length === 0 ? (
        <EmptyState title="No children are linked to your account. Ask the school office." />
      ) : (
        me.body.children.map((child) => <ChildCard key={child.studentId} child={child} />)
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  today: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  todayText: { flex: 1, gap: 2 },
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
