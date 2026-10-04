import { Capability, formatDay } from '@asms/shared';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { RemarkDto, SubjectDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import { discardItem, listLocalRemarks, type LocalRemark } from '../db/local.repository';
import { useCachedQuery } from '../db/use-cached-query';
import { ownSubjects } from '../diary/DiaryComposeScreen';
import { useOnline } from '../net/connectivity';
import { remedyFor } from '../outbox/lanes';
import { useLocalQuery } from '../outbox/runtime';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { localState, StateLine } from '../ui/StateLine';
import { EmptyState, NoDataState, OfflineNotice } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize, space } from '../ui/theme';
import { CATEGORY_LABELS, RemarkForm } from './RemarkForm';
import { useTodayRoster } from './StudentsScreen';

// One student — /classes/[sectionId]/students/[studentId] (slice-16 §4.6): name and roll from the
// section's cached roster, the remarks staff may read (every visibility, corrections hidden as the
// server does), this phone's unsent remarks with their state, and "New remark". Secure.

const VISIBILITY_BADGE = {
  internal: 'Staff only',
  guardian: 'Parents',
  student: 'Parents and student',
};

export function StudentSheetScreen({
  sectionId,
  studentId,
  secure,
}: {
  sectionId: string;
  studentId: string;
  secure?: boolean;
}) {
  const online = useOnline();
  const { me } = useSession();
  const [formOpen, setFormOpen] = useState(false);
  const [resend, setResend] = useState<LocalRemark | null>(null);
  const roster = useTodayRoster(sectionId);
  const row = roster.data?.body.roster.find((r) => r.studentId === studentId);
  const remarks = useCachedQuery<{ data: RemarkDto[] }>(
    queryKeys.studentRemarks(studentId, 1),
    `/api/v1/students/${studentId}/remarks`,
    { limit: 25, page: 1 },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/students/{id}/remarks', {
          params: { path: { id: studentId }, query: { limit: 25, page: 1 } },
        }),
      ),
  );
  const local = useLocalQuery(queryKeys.localRemarks(studentId), () => listLocalRemarks(studentId));
  const classId = roster.data?.body.section.classId ?? null;
  const own = me ? ownSubjects(me.body, Capability.REMARK_WRITE, sectionId, classId) : [];
  const school = useCachedQuery<{ data: SubjectDto[] }>(
    queryKeys.subjects,
    '/api/v1/subjects',
    { limit: 50 },
    () => unwrapWithDate(api.GET('/api/v1/subjects', { params: { query: { limit: 50 } } })),
    { enabled: own === 'all' && formOpen },
  );
  const subjects =
    own === 'all'
      ? (school.data?.body.data ?? [])
          .filter((s) => s.archivedAt === null)
          .map((s) => ({ id: s.id, name: s.name }))
      : own;
  const canWrite = me?.body.capabilities.includes(Capability.REMARK_WRITE) ?? false;
  const shownServerIds = new Set(
    (local.data ?? []).flatMap((r) => (r.serverId ? [r.serverId] : [])),
  );
  const cached = remarks.data;

  function discard(remark: LocalRemark) {
    if (remark.outbox === null) return;
    const outboxId = remark.outbox.id;
    Alert.alert('Discard this remark?', 'It has not reached the school and will be lost.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => void discardItem(outboxId).then(() => local.refetch()),
      },
    ]);
  }

  return (
    <Screen
      title={row?.studentFullName ?? 'Student'}
      accessory={<SyncChip />}
      secure={secure}
      banner={
        cached !== undefined && (!online || remarks.isError) ? (
          <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        ) : null
      }
      testID="student.screen"
      footer={
        canWrite ? (
          <Button
            label="New remark"
            onPress={() => {
              setResend(null);
              setFormOpen(true);
            }}
            testID="student.newRemark"
          />
        ) : null
      }
    >
      {row ? (
        <Text style={styles.caption}>
          {[
            roster.data
              ? `${roster.data.body.section.className} ${roster.data.body.section.name}`
              : null,
            row.rollNo === null ? null : `Roll ${row.rollNo}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      ) : null}
      {(local.data ?? []).length > 0 ? (
        <Sheet title="On this phone" testID="student.localRemarks">
          {(local.data ?? []).map((remark) => {
            const failed = remark.outbox?.state === 'failed';
            const remedy = failed ? remedyFor('remark', remark.outbox?.responseCode ?? null) : null;
            return (
              <View key={remark.id} style={styles.item} testID={`student.local.${remark.id}`}>
                <Text style={styles.heading}>
                  {`${CATEGORY_LABELS[remark.category as keyof typeof CATEGORY_LABELS] ?? remark.category} · ${formatDay(remark.date)}`}
                </Text>
                <Text style={styles.body}>{remark.text}</Text>
                <StateLine state={localState(remark.outbox, remark.savedOnServerAt)} />
                {remedy === 'edit_resend' ? (
                  <Button
                    label="Edit and resend"
                    variant="secondary"
                    onPress={() => {
                      setResend(remark);
                      setFormOpen(true);
                    }}
                    testID={`student.local.${remark.id}.edit`}
                  />
                ) : null}
                {failed || remark.outbox?.state === 'pending' ? (
                  <Button
                    label="Discard"
                    variant="destructive"
                    onPress={() => discard(remark)}
                    testID={`student.local.${remark.id}.discard`}
                  />
                ) : null}
              </View>
            );
          })}
        </Sheet>
      ) : null}
      {cached === undefined ? (
        <NoDataState
          isError={remarks.isError}
          error={remarks.error}
          onRetry={() => void remarks.refetch()}
          offlineMessage="This student's remarks are not on this phone yet."
        />
      ) : cached.body.data.filter((r) => !shownServerIds.has(r.id)).length === 0 &&
        (local.data ?? []).length === 0 ? (
        <EmptyState title="No remarks." />
      ) : (
        <Sheet title="Remarks">
          {cached.body.data
            .filter((r) => !shownServerIds.has(r.id))
            .map((remark) => (
              <View key={remark.id} style={styles.item} testID={`student.remark.${remark.id}`}>
                <Text style={styles.heading}>
                  {[
                    CATEGORY_LABELS[remark.category],
                    formatDay(remark.date),
                    remark.subjectName,
                    VISIBILITY_BADGE[remark.visibility],
                    remark.supersededAt ? 'corrected' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <Text style={styles.body}>{remark.text}</Text>
                <Text style={styles.caption}>{remark.authorName}</Text>
              </View>
            ))}
        </Sheet>
      )}
      <RemarkForm
        visible={formOpen}
        studentId={studentId}
        subjects={subjects}
        resend={resend}
        onClose={() => setFormOpen(false)}
        onSaved={() => void local.refetch()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { gap: space.xs, paddingVertical: space.sm },
  heading: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
