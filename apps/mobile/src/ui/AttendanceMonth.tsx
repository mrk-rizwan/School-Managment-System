import { formatDay } from '@asms/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MyStaffAttendanceDto, StudentAttendanceDto } from '../api/contracts';
import { ModalSheet } from './ModalSheet';
import { StatusChip } from './StatusChip';
import { colors, fontSize, radius, space, statusTone, TAP_TARGET, type ChipStatus } from './theme';

// One month of attendance (slice-16 §5.2, §6): a child's, a student's own, or a staff member's.
// A 7-column grid, Sunday first; each cell is the day's chip and number; a legend; the summary
// line. It renders only the fields the DTO has — no note and no teacher exist in these DTOs
// (R165), so none can appear.

type Cell = {
  date: string;
  status: ChipStatus | null;
  /** A day that counts: teaching day while enrolled, or working day while employed. */
  counts: boolean;
  periods: { period: number; status: ChipStatus; arrivedAt: string | null }[] | null;
  amended: boolean;
};

type Props =
  | { kind: 'student'; data: StudentAttendanceDto; testID?: string }
  | { kind: 'staff'; data: MyStaffAttendanceDto; testID?: string };

function cellsOf(props: Props): Cell[] {
  if (props.kind === 'student') {
    return props.data.days.map((day) => ({
      date: day.date,
      status: day.status,
      counts: day.teachingDay && day.enrolled,
      periods: day.periods,
      amended: false,
    }));
  }
  return props.data.days.map((day) => ({
    date: day.date,
    status: day.status,
    counts: day.workingDay && day.employed,
    periods: null,
    amended: day.amended,
  }));
}

/** The words of the summary line. */
export function summaryLine(props: Props): string[] {
  const d = props.data;
  const counts = [
    `${d.present} present`,
    `${d.absent} absent`,
    `${d.late} late`,
    `${d.onLeave} on leave`,
  ];
  if (props.kind === 'student') {
    const s = props.data;
    const head =
      s.percentage === null
        ? 'No recorded days yet'
        : `${s.percentage}% — ${s.countedDays} of ${s.teachingDays} days`;
    const lines = [
      head,
      [...counts, `${s.partial} partly absent`, `${s.unrecorded} not recorded`].join(' · '),
    ];
    if (s.excludedLeaveDays > 0) {
      lines.push(
        `${s.excludedLeaveDays} leave ${s.excludedLeaveDays === 1 ? 'day' : 'days'} not counted`,
      );
    }
    return lines;
  }
  const s = props.data;
  return [
    `${s.workingDays} working ${s.workingDays === 1 ? 'day' : 'days'}`,
    [...counts, `${s.unrecorded} not recorded`].join(' · '),
  ];
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function AttendanceMonth(props: Props) {
  const cells = cellsOf(props);
  const [open, setOpen] = useState<Cell | null>(null);
  const lead = cells.length > 0 ? weekday(cells[0]!.date) : 0;
  const testID = props.testID ?? 'attendanceMonth';
  const dayWord = props.kind === 'student' ? 'school day' : 'working day';

  return (
    <View style={styles.wrap}>
      <View style={styles.weekdays}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((letter, index) => (
          <Text key={index} style={styles.weekday}>
            {letter}
          </Text>
        ))}
      </View>
      <View style={styles.grid} testID={`${testID}.grid`}>
        {Array.from({ length: lead }, (_, index) => (
          <View key={`lead-${index}`} style={styles.cell} />
        ))}
        {cells.map((cell) => (
          <Pressable
            key={cell.date}
            accessibilityRole="button"
            accessibilityLabel={`${formatDay(cell.date)}: ${describeCell(cell, dayWord)}`}
            onPress={() => setOpen(cell)}
            style={[styles.cell, !cell.counts && styles.muted]}
            testID={`${testID}.day.${cell.date}`}
          >
            <Text style={styles.dayNumber}>{Number(cell.date.slice(8))}</Text>
            {cell.counts ? (
              <View
                style={[
                  styles.mini,
                  { backgroundColor: statusTone(cell.status).background },
                  cell.status === null && styles.hollow,
                  cell.status === 'partial' && styles.dashed,
                ]}
              >
                <Text style={[styles.miniLetter, { color: statusTone(cell.status).foreground }]}>
                  {statusTone(cell.status).letter}
                </Text>
              </View>
            ) : null}
          </Pressable>
        ))}
      </View>
      <View style={styles.legend} testID={`${testID}.legend`}>
        {(
          [
            'present',
            'absent',
            'late',
            'on_leave',
            ...(props.kind === 'student' ? (['partial'] as const) : []),
          ] as const
        ).map((status) => (
          <View key={status} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: statusTone(status).background }]} />
            <Text style={styles.legendText}>{statusTone(status).word}</Text>
          </View>
        ))}
        <View style={styles.legendItem}>
          <View
            style={[styles.dot, styles.hollow, { backgroundColor: statusTone(null).background }]}
          />
          <Text style={styles.legendText}>Not recorded</Text>
        </View>
      </View>
      {summaryLine(props).map((line) => (
        <Text key={line} style={styles.summary} testID={`${testID}.summary`}>
          {line}
        </Text>
      ))}
      <ModalSheet
        visible={open !== null}
        title={open === null ? '' : formatDay(open.date)}
        onClose={() => setOpen(null)}
        testID={`${testID}.daySheet`}
      >
        {open === null ? null : (
          <>
            <View style={styles.sheetRow}>
              <StatusChip status={open.counts ? open.status : null} />
              <Text style={styles.sheetText}>{describeCell(open, dayWord)}</Text>
            </View>
            {(open.periods ?? []).map((period) => (
              <Text key={period.period} style={styles.sheetText}>
                {`Period ${period.period} — ${statusTone(period.status).word}${
                  period.status === 'late' && period.arrivedAt
                    ? ` (arrived ${period.arrivedAt})`
                    : ''
                }`}
              </Text>
            ))}
            {open.amended ? <Text style={styles.legendText}>Amended</Text> : null}
          </>
        )}
      </ModalSheet>
    </View>
  );
}

function describeCell(cell: Cell, dayWord: string): string {
  if (!cell.counts) return `Not a ${dayWord}`;
  return statusTone(cell.status).word;
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  weekdays: { flexDirection: 'row' },
  weekday: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    fontSize: fontSize.caption,
    color: colors.mutedForeground,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    minHeight: TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: radius,
  },
  muted: { opacity: 0.4 },
  dayNumber: { fontSize: fontSize.small, color: colors.foreground },
  dot: { width: 14, height: 14, borderRadius: 7 },
  mini: { width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  miniLetter: { fontSize: fontSize.caption, fontWeight: '700' },
  dashed: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.background },
  hollow: { borderWidth: 1, borderColor: colors.mutedForeground },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  legendText: { fontSize: fontSize.caption, color: colors.mutedForeground },
  summary: { fontSize: fontSize.small, color: colors.foreground },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  sheetText: { fontSize: fontSize.body, color: colors.foreground },
});
