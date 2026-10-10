import { Capability, formatDay, todayInSchool } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrap } from '../api/client';
import type {
  MyStaffTimetableDto,
  MyStaffTimetablePeriodDto,
  MyTimetableDto,
} from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { holds } from '../auth/capabilities';
import { useSession } from '../auth/session';
import { sectionTitle } from '../classes/my-classes';
import type { FamilySource } from '../family/source';
import { useOnline } from '../net/connectivity';
import { addDays, mondayOf } from '../platform/dates';
import { ListRow } from '../ui/ListRow';
import { MonthHeader } from '../ui/MonthHeader';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize } from '../ui/theme';

// The period timetable on the phone (Phase 5 slice 37, contracts/slice-37.md §7): the teacher's
// week (Classes → Timetable) and a section's week for a guardian's child or the student's own,
// a day at a time. Online only and never cached on the phone, like Results: no outbox lane, and a
// substitution can change a day at any time. Not secure: neither DTO carries a child's name.

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Day = { date: string; weekday: number; teachingDay: boolean };

/** The day shown first: today when it is in the week, else the first teaching day, else Monday. */
export function defaultDay(days: readonly Day[], today: string): string | null {
  if (days.some((d) => d.date === today)) return today;
  return (days.find((d) => d.teachingDay) ?? days[0])?.date ?? null;
}

/** "Mon 12": a day-switcher label. */
export const dayLabel = (day: Day) => `${WEEKDAY_SHORT[day.weekday]} ${Number(day.date.slice(8))}`;

/** The staff row's right-hand value: a substitution the teacher takes, or their slot taken. */
export function staffPeriodValue(p: MyStaffTimetablePeriodDto): string | null {
  if (p.kind === 'substitution') return 'Substitution';
  return p.substitutedByName === null ? null : `Taken by ${p.substitutedByName}`;
}

const roomLine = (room: string | null) => (room === null ? null : `Room ${room}`);
const join = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ') || null;

/** Week navigation and the chosen day: the anchor is any day of the week asked for. */
function useWeek() {
  const today = todayInSchool();
  const [anchor, setAnchor] = useState(today);
  const [chosen, setChosen] = useState<string | null>(null);
  const move = (weeks: number) => {
    setAnchor(addDays(anchor, 7 * weeks));
    setChosen(null);
  };
  return { today, anchor, chosen, setChosen, move };
}

/** The frame both screens share: offline, loading, error, then the week header and day picker. */
function WeekFrame<D extends Day>({
  title,
  testID,
  week,
  query,
  render,
  caption,
  notice,
}: {
  title: string;
  testID: string;
  week: ReturnType<typeof useWeek>;
  query: {
    data: { weekOf: string; days: D[] } | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
    isRefetching: boolean;
  };
  render: (day: D) => ReactNode;
  caption?: ReactNode;
  /** Shown instead of the day picker and the day: the week has nothing to pick from. */
  notice?: ReactNode;
}) {
  const online = useOnline();
  if (!online) {
    return (
      <Screen title={title} testID={testID}>
        <EmptyState title="Needs a connection" description="The timetable is read online only." />
      </Screen>
    );
  }
  const data = query.data;
  const monday = data?.weekOf ?? mondayOf(week.anchor);
  const shown = data ? (week.chosen ?? defaultDay(data.days, week.today)) : null;
  const day = data?.days.find((d) => d.date === shown);
  return (
    <Screen
      title={title}
      testID={testID}
      refreshing={query.isRefetching}
      onRefresh={() => void query.refetch()}
    >
      <MonthHeader
        title={`Week of ${formatDay(monday)}`}
        onPrevious={() => week.move(-1)}
        onNext={() => week.move(1)}
        testID="timetable.week"
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError || data === undefined ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : notice ? (
        notice
      ) : (
        <>
          {caption}
          <SegmentedPicker
            label="Day"
            options={data.days.map((d) => ({ value: d.date, label: dayLabel(d) }))}
            value={shown}
            onChange={week.setChosen}
            testID="timetable.day"
          />
          {day === undefined ? null : !day.teachingDay ? (
            <EmptyState title="No school on this day" />
          ) : (
            render(day)
          )}
        </>
      )}
    </Screen>
  );
}

/** Classes → Timetable: the teacher's own week, substitutions marked; a tap opens the register. */
export function StaffTimetableScreen() {
  const router = useRouter();
  const online = useOnline();
  const { me } = useSession();
  const week = useWeek();
  const query = useQuery({
    queryKey: queryKeys.staffTimetable(week.anchor),
    queryFn: (): Promise<MyStaffTimetableDto> =>
      unwrap(api.GET('/api/v1/me/staff/timetable', { params: { query: { weekOf: week.anchor } } })),
    enabled: online,
  });
  const canMark = me !== null && holds(me.body, Capability.ATTENDANCE_STUDENT_MARK);
  // A daily-mode section keeps one register a day, stored as period 1 (rule 14).
  const daily = new Set(
    (me?.body.assignments ?? [])
      .filter((a) => a.attendanceMode === 'daily' && a.sectionId !== null)
      .map((a) => a.sectionId),
  );
  const openRegister = (date: string, p: MyStaffTimetablePeriodDto) =>
    router.push({
      pathname: '/classes/[sectionId]/register',
      params: {
        sectionId: p.sectionId,
        date,
        period: daily.has(p.sectionId) ? '1' : String(p.period),
      },
    });

  return (
    <WeekFrame
      title="Timetable"
      testID="timetable.screen"
      week={week}
      query={query}
      render={(day) =>
        day.periods.length === 0 ? (
          <EmptyState title="No periods on this day" />
        ) : (
          <Sheet testID={`timetable.dayList.${day.date}`}>
            {[...day.periods]
              .sort((a, b) => a.period - b.period)
              .map((p) => (
                <ListRow
                  key={`${p.period}.${p.sectionId}.${p.kind}`}
                  title={`Period ${p.period} · ${sectionTitle(p.className, p.sectionName)}`}
                  detail={join([p.subjectName, roomLine(p.room)])}
                  value={staffPeriodValue(p)}
                  onPress={
                    canMark && p.substitutedByName === null
                      ? () => openRegister(day.date, p)
                      : undefined
                  }
                  testID={`timetable.period.${p.period}.${p.sectionId}`}
                />
              ))}
          </Sheet>
        )
      }
    />
  );
}

/** A child's (or the student's own) section week: period, subject, teacher and room. */
export function FamilyTimetableScreen({ source }: { source: FamilySource }) {
  const online = useOnline();
  const week = useWeek();
  const studentId = source.kind === 'child' ? source.studentId : null;
  const query = useQuery({
    queryKey: queryKeys.familyTimetable(studentId, week.anchor),
    queryFn: (): Promise<MyTimetableDto> => {
      const query = { date: week.anchor };
      return source.kind === 'child'
        ? unwrap(
            api.GET('/api/v1/me/children/{id}/timetable', {
              params: { path: { id: source.studentId }, query },
            }),
          )
        : unwrap(api.GET('/api/v1/me/student/timetable', { params: { query } }));
    },
    enabled: online,
  });
  const data = query.data;
  const noSection = data !== undefined && data.sectionName === null;
  return (
    <WeekFrame
      title="Timetable"
      testID="familyTimetable.screen"
      week={week}
      query={query}
      caption={
        data === undefined ? null : (
          <Text style={styles.caption} testID="familyTimetable.section">
            {sectionTitle(data.className ?? '', data.sectionName ?? '')}
          </Text>
        )
      }
      notice={
        noSection ? (
          <EmptyState
            title="Not in a class this week"
            description="The timetable shows once the school places the student in a section."
          />
        ) : null
      }
      render={(day) =>
        day.periods.length === 0 ? (
          <EmptyState title="No timetable for this day yet" />
        ) : (
          <Sheet testID={`familyTimetable.dayList.${day.date}`}>
            {[...day.periods]
              .sort((a, b) => a.period - b.period)
              .map((p) => (
                <ListRow
                  key={p.period}
                  title={`Period ${p.period} · ${p.subjectName}`}
                  detail={join([p.teacherName, roomLine(p.room)])}
                  testID={`familyTimetable.period.${p.period}`}
                />
              ))}
          </Sheet>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
