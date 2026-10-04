import { formatDay, todayInSchool } from '@asms/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MyDiaryEntryDto, MyRemarkDto, StudentAttendanceDto } from '../api/contracts';
import { useSession } from '../auth/session';
import { useCachedQuery } from '../db/use-cached-query';
import { fortnightWindow } from '../diary/dates';
import { DiaryEntrySheet, DiaryWindow, entryView } from '../diary/DiaryEntrySheet';
import { useOnline } from '../net/connectivity';
import { monthRange } from '../platform/dates';
import { CATEGORY_LABELS } from '../remarks/RemarkForm';
import { AttendanceMonth } from '../ui/AttendanceMonth';
import { Button } from '../ui/Button';
import { MonthHeader } from '../ui/MonthHeader';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { AsOf, EmptyState, NoDataState, OfflineNotice } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import {
  attachmentBase,
  familyRead,
  type FamilySource,
} from './source';

// A child's (or a student's own) attendance, diary and remarks (slice-16 §5.2–§5.5). One
// component per concern, bound to a source; every one is secure — the header is a child's name.
// They render only what the /me DTOs carry: no note, no teacher, no phone exists there (R165).

/** The header: the child's name from /me, or the student's own. */
function useSubjectName(source: FamilySource): string {
  const { me } = useSession();
  if (me === null) return '';
  if (source.kind === 'own') return me.body.fullName;
  return me.body.children.find((c) => c.studentId === source.studentId)?.fullName ?? '';
}

/** The month at `offset` from this one; this month runs to today (the children cards' key). */
export function attendanceMonth(today: string, offset: number) {
  const month = monthRange(today, offset);
  return offset === 0 ? { ...month, dateTo: today } : month;
}

function offlineBanner(
  cached: { serverTime: string; serverTimeIsDevice: boolean } | undefined,
  online: boolean,
  failed: boolean,
) {
  return cached !== undefined && (!online || failed) ? (
    <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
  ) : null;
}

export function FamilyAttendanceScreen({
  source,
  secure,
}: {
  source: FamilySource;
  secure?: boolean;
}) {
  const online = useOnline();
  const name = useSubjectName(source);
  const [offset, setOffset] = useState(0);
  const month = attendanceMonth(todayInSchool(), offset);
  const read = familyRead(source, 'attendance', month);
  const query = useCachedQuery<StudentAttendanceDto>(read.key, read.path, read.params, read.fetch);
  const cached = query.data;
  return (
    <Screen
      title={name}
      secure={secure}
      banner={offlineBanner(cached, online, query.isError)}
      testID="attendance.screen"
    >
      <MonthHeader
        title={month.title}
        onPrevious={() => setOffset(offset - 1)}
        onNext={() => setOffset(offset + 1)}
        nextDisabled={offset >= 0}
        testID="attendanceMonth"
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
          <AttendanceMonth kind="student" data={cached.body} />
        </>
      )}
    </Screen>
  );
}

function DiaryFortnight({
  source,
  back,
  onOpen,
}: {
  source: FamilySource;
  back: number;
  onOpen: (entry: MyDiaryEntryDto) => void;
}) {
  const range = fortnightWindow(todayInSchool(), back);
  const read = familyRead(source, 'diary', range);
  const query = useCachedQuery(read.key, read.path, read.params, read.fetch);
  return (
    <DiaryWindow
      query={query}
      range={range}
      rowTitle={(entry) =>
        `${formatDay(entry.date)} · ${entry.className} ${entry.sectionName} · ${entry.subjectName}`
      }
      onOpen={onOpen}
      testID={`familyDiary.window.${back}`}
      entryTestID={(entry) => `familyDiary.entry.${entry.id}`}
      offlineMessage="This part of the diary is not on this phone yet."
    />
  );
}

export function FamilyDiaryScreen({ source, secure }: { source: FamilySource; secure?: boolean }) {
  const online = useOnline();
  const name = useSubjectName(source);
  const [windows, setWindows] = useState(1);
  const [open, setOpen] = useState<MyDiaryEntryDto | null>(null);
  return (
    <Screen
      title={name}
      secure={secure}
      banner={!online ? <OfflineNotice serverTime={null} /> : null}
      testID="familyDiary.screen"
    >
      <Text style={styles.heading}>Diary</Text>
      {Array.from({ length: windows }, (_, back) => (
        <DiaryFortnight key={back} source={source} back={back} onOpen={setOpen} />
      ))}
      <Button
        label="Earlier"
        variant="secondary"
        onPress={() => setWindows(windows + 1)}
        testID="familyDiary.earlier"
      />
      <DiaryEntrySheet
        entry={open ? entryView(open, `${open.className} ${open.sectionName} · ${open.subjectName}`) : null}
        attachmentBase={open ? attachmentBase(source, open.id) : null}
        onClose={() => setOpen(null)}
      />
    </Screen>
  );
}

export function FamilyRemarksScreen({
  source,
  secure,
}: {
  source: FamilySource;
  secure?: boolean;
}) {
  const online = useOnline();
  const name = useSubjectName(source);
  const read = familyRead(source, 'remarks', null);
  const query = useCachedQuery(read.key, read.path, read.params, read.fetch);
  const cached = query.data;
  return (
    <Screen
      title={name}
      secure={secure}
      banner={offlineBanner(cached, online, query.isError)}
      testID="familyRemarks.screen"
    >
      <Text style={styles.heading}>Remarks</Text>
      {cached === undefined ? (
        <NoDataState
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          offlineMessage="The remarks are not on this phone yet."
        />
      ) : cached.body.data.length === 0 ? (
        <EmptyState title="No remarks." />
      ) : (
        <Sheet>
          {cached.body.data.map((remark: MyRemarkDto) => (
            <View
              key={remark.id}
              style={[styles.item, remark.supersededAt !== null && styles.superseded]}
              testID={`familyRemarks.remark.${remark.id}`}
            >
              <Text style={styles.itemHeading}>
                {[CATEGORY_LABELS[remark.category], formatDay(remark.date), remark.subjectName]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Text style={styles.body}>{remark.text}</Text>
              <Text style={styles.caption}>{remark.authorName}</Text>
              {remark.supersededAt !== null ? (
                <Text style={styles.caption}>Corrected — see the newer remark</Text>
              ) : null}
            </View>
          ))}
        </Sheet>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  item: { gap: space.xs, paddingVertical: space.sm },
  superseded: { opacity: 0.6 },
  itemHeading: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  body: { fontSize: fontSize.body, color: colors.foreground },
});
