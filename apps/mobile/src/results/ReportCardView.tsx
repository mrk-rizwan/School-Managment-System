import {
  EXAM_MARKER_LEGEND,
  examMarker,
  formatDay,
  formatPercentLabel as percent,
  resultTermLabel,
} from '@asms/shared';
import { Share, StyleSheet, Text, View } from 'react-native';
import type { ResultDto } from '../api/contracts';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { colors, fontSize, space } from '../ui/theme';

// The report card on the phone (phase-4-academic.md §3.4, slice 32, R279, R284): ResultDto — the
// stored result row — rendered natively, one layout. The year's display toggles have already
// nulled what they hide. Shared as text (the app ships no view-capture library; receipts and
// payslips share the same way). The screen that shows it is secure (FamilyResults).

const subjectMark = (s: ResultDto['subjects'][number]): string =>
  s.status === 'assessed' && s.obtained !== null ? `${s.obtained} / ${s.max}` : '—';

/** The subject's name with its exam marker (rule 26: "Ab" absent, "Ex" excused). */
const subjectName = (s: ResultDto['subjects'][number]): string => {
  const marker = examMarker(s);
  return marker === null ? s.subjectName : `${s.subjectName} (${marker})`;
};

const hasMarker = (r: ResultDto): boolean => r.subjects.some((s) => examMarker(s) !== null);

/** The card as plain text, for Share (figures only; no identity number is ever on a card). */
export function reportCardText(r: ResultDto): string {
  const lines = [
    r.schoolName,
    `Report card · ${resultTermLabel(r)} · ${r.academicYearName}`,
    `${r.studentName} · ${r.className} ${r.sectionName}${r.rollNo === null ? '' : ` · Roll ${r.rollNo}`}`,
    ...(r.supersededAt !== null ? ['SUPERSEDED: a corrected version exists'] : []),
    ...(r.revised && r.supersededAt === null && r.publishedAt ? [`Revised on ${formatDay(r.publishedAt.slice(0, 10))}`] : []),
    '',
    ...r.subjects.map((s) => `${subjectName(s)}: ${subjectMark(s)}${s.grade && s.status === 'assessed' ? ` (${s.grade})` : ''}`),
    ...(hasMarker(r) ? [EXAM_MARKER_LEGEND] : []),
    '',
    `Total: ${r.totalObtained} / ${r.totalMax} · ${percent(r.percentBp)}${r.grade ? ` · Grade ${r.grade}` : ''}`,
    ...(r.passed === null ? [] : [r.passed ? 'Passed' : 'Not passed']),
    ...(r.position !== null && r.positionOf !== null ? [`Position: ${r.position} / ${r.positionOf}`] : []),
    ...(r.showAttendance && r.attendanceBp !== null ? [`Attendance: ${percent(r.attendanceBp)}`] : []),
    ...(r.remark ? [`Remark: ${r.remark}`] : []),
  ];
  return lines.join('\n');
}

export function ReportCardView({ result: r }: { result: ResultDto }) {
  return (
    <View testID="reportCard">
      <Sheet>
        <View style={styles.head}>
          <Text style={styles.school}>{r.schoolName}</Text>
          <Text style={styles.caption}>
            Report card · {resultTermLabel(r)} · {r.academicYearName}
          </Text>
          <Text style={styles.body}>
            {r.studentName} · {r.className} {r.sectionName}
            {r.rollNo === null ? '' : ` · Roll ${r.rollNo}`}
          </Text>
          {r.supersededAt !== null ? (
            <Text style={styles.superseded} testID="reportCard.superseded">
              Superseded: a corrected version exists
            </Text>
          ) : r.revised && r.publishedAt ? (
            <Text style={styles.revised} testID="reportCard.revised">
              Revised on {formatDay(r.publishedAt.slice(0, 10))}
            </Text>
          ) : null}
        </View>
        <View style={styles.row}>
          <Text style={[styles.cell, styles.th]}>Subject</Text>
          <Text style={[styles.num, styles.th]}>Marks</Text>
          <Text style={[styles.grade, styles.th]}>Grade</Text>
        </View>
        {r.subjects.map((s) => (
          <View key={s.classSubjectId} style={styles.row} testID={`reportCard.subject.${s.classSubjectId}`}>
            <Text style={styles.cell}>{subjectName(s)}</Text>
            <Text style={styles.num}>{subjectMark(s)}</Text>
            <Text style={styles.grade}>{s.status === 'assessed' ? (s.grade ?? '') : '—'}</Text>
          </View>
        ))}
        <View style={[styles.row, styles.total]}>
          <Text style={[styles.cell, styles.th]}>Total</Text>
          <Text style={[styles.num, styles.th]}>
            {r.totalObtained} / {r.totalMax}
          </Text>
          <Text style={[styles.grade, styles.th]}>{r.grade ?? '—'}</Text>
        </View>
        {hasMarker(r) ? (
          <Text style={styles.legend} testID="reportCard.legend">
            {EXAM_MARKER_LEGEND}
          </Text>
        ) : null}
        <View style={styles.summary}>
          <Text style={styles.body} testID="reportCard.percent">
            {percent(r.percentBp)}
            {r.passed === null ? '' : r.passed ? ' · Passed' : ' · Not passed'}
          </Text>
          {r.position !== null && r.positionOf !== null ? (
            <Text style={styles.body} testID="reportCard.position">
              Position {r.position} / {r.positionOf}
            </Text>
          ) : null}
          {r.showAttendance && r.attendanceBp !== null ? (
            <Text style={styles.body}>Attendance {percent(r.attendanceBp)}</Text>
          ) : null}
          {r.remark ? <Text style={styles.remark}>“{r.remark}”</Text> : null}
        </View>
      </Sheet>
      <Button
        label="Share"
        onPress={() => void Share.share({ message: reportCardText(r) })}
        testID="reportCard.share"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: space.xs, paddingBottom: space.md },
  school: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  body: { fontSize: fontSize.body, color: colors.foreground },
  revised: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  superseded: { fontSize: fontSize.small, fontWeight: '600', color: colors.destructive },
  row: { flexDirection: 'row', gap: space.sm, paddingVertical: space.xs },
  total: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: space.xs },
  th: { fontWeight: '600' },
  cell: { flex: 1, fontSize: fontSize.body, color: colors.foreground },
  num: { width: 96, textAlign: 'right', fontSize: fontSize.body, color: colors.foreground, fontVariant: ['tabular-nums'] },
  grade: { width: 48, textAlign: 'right', fontSize: fontSize.body, color: colors.foreground },
  legend: { fontSize: fontSize.small, color: colors.mutedForeground, paddingTop: space.xs },
  summary: { gap: space.xs, paddingTop: space.md },
  remark: { fontSize: fontSize.body, color: colors.foreground, fontStyle: 'italic' },
});
