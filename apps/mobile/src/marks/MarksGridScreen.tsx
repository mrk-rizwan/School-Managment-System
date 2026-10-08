import { formatDay } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { AssessmentMarkRowDto, AssessmentMarksDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { readCachedPrefix } from '../db/cache';
import { discardItem } from '../db/local.repository';
import {
  dropChangedElsewhere,
  getLocalAssessment,
  readLocalMarks,
  saveMarks,
  type AssessmentRef,
  type LocalAssessment,
  type LocalAssessmentMark,
} from '../db/local-marks.repository';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { remedyFor } from '../outbox/lanes';
import { outboxWorker, useLocalQuery } from '../outbox/runtime';
import { log } from '../platform/log';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { localState, StateLine } from '../ui/StateLine';
import { cachedOfflineBanner, EmptyState, LoadingState, NoDataState } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize, radius, space, TAP_TARGET } from '../ui/theme';
import { draftOf, markedLine, marksToSave, rowValue, type Draft } from './marks-model';

// The marks grid — /marks/test/[id] (plan §3.8, contracts/slice-30.md §9). The server's grid
// (cached per test, so it reads offline) overlaid with the marks typed on this phone; Save writes
// them on the device with their outbox row in one transaction and says so. A test made on this
// phone and not yet on the server takes marks against the section's students from another of its
// grids on the phone; they wait for the test's server id. Children's names: secure.

/** The section's students from the newest grid of another test on this phone (a local test's roster). */
async function cachedRoster(sectionId: string): Promise<AssessmentMarkRowDto[] | null> {
  const grids = await readCachedPrefix<AssessmentMarksDto>('GET /api/v1/assessments/');
  const grid = grids.find(
    (g) => Array.isArray(g.body.rows) && g.body.assessment?.sectionId === sectionId,
  );
  if (grid === undefined) return null;
  return grid.body.rows.map((row) => ({
    ...row,
    markId: null,
    obtained: null,
    absent: false,
    excused: false,
    status: null,
    enteredAt: null,
  }));
}

/** `secure`: the grid names children (FLAG_SECURE, slice-16 §13.2); its route always passes it. */
export function MarksGridScreen({
  id,
  local,
  secure,
}: {
  id: string;
  local: boolean;
  secure: boolean;
}) {
  const test = useLocalQuery(['local', 'assessment', id], () =>
    local ? getLocalAssessment(id) : Promise.resolve(null),
  );
  if (!local) return <ServerGrid assessmentId={id} secure={secure} />;
  if (test.data === undefined) return <LoadingState />;
  if (test.data === null) return <EmptyState title="This test is no longer on this phone." />;
  // Once the server has it, its own grid.
  if (test.data.serverId !== null)
    return <ServerGrid assessmentId={test.data.serverId} secure={secure} />;
  return <LocalGrid test={test.data} secure={secure} />;
}

function ServerGrid({ assessmentId, secure }: { assessmentId: string; secure: boolean }) {
  const online = useOnline();
  const grid = useCachedQuery<AssessmentMarksDto>(
    queryKeys.assessmentGrid(assessmentId),
    `/api/v1/assessments/${assessmentId}/marks`,
    {},
    () =>
      unwrapWithDate(
        api.GET('/api/v1/assessments/{id}/marks', { params: { path: { id: assessmentId } } }),
      ),
  );
  const data = grid.data?.body;
  if (data === undefined) {
    return (
      <Screen title="Marks" accessory={<SyncChip />} secure={secure} testID="marks.grid.screen">
        <NoDataState
          isError={grid.isError}
          error={grid.error}
          onRetry={() => void grid.refetch()}
          offlineMessage="This test's marks are not on this phone yet. Open it once while connected."
        />
      </Screen>
    );
  }
  const a = data.assessment;
  return (
    <Grid
      ref_={{ serverId: assessmentId }}
      secure={secure}
      title={a.name}
      caption={`${a.className} ${a.sectionName} · ${a.subjectName} · ${formatDay(a.heldOn)} · out of ${a.maxMarks}`}
      maxMarks={a.maxMarks}
      rows={data.rows}
      editable={a.canEnterMarks}
      readOnlyReason={
        a.voidedAt
          ? 'This test was voided.'
          : a.locked
            ? 'Locked: the result sheet for this term was submitted.'
            : 'Viewing only: you do not teach this subject here.'
      }
      banner={cachedOfflineBanner(grid.data, online, grid.isError)}
      onReload={() => void grid.refetch()}
    />
  );
}

function LocalGrid({ test, secure }: { test: LocalAssessment; secure: boolean }) {
  const roster = useQuery({
    queryKey: queryKeys.localRoster(test.sectionId),
    queryFn: () => cachedRoster(test.sectionId),
    networkMode: 'always',
  });
  if (roster.isPending) return <LoadingState />;
  const rows = roster.data ?? null;
  return (
    <Grid
      ref_={{ localId: test.id }}
      secure={secure}
      title={test.name}
      caption={`${formatDay(test.heldOn)} · out of ${test.maxMarks} · not on the server yet`}
      maxMarks={test.maxMarks}
      rows={rows ?? []}
      editable={rows !== null && test.outbox?.state !== 'failed'}
      readOnlyReason={
        rows === null
          ? 'Open another test of this section once while connected, so its students are on this phone.'
          : 'This test was refused. Discard it or edit and resend it from the list.'
      }
      banner={null}
      onReload={() => void roster.refetch()}
    />
  );
}

function Grid({
  ref_,
  secure,
  title,
  caption,
  maxMarks,
  rows,
  editable,
  readOnlyReason,
  banner,
  onReload,
}: {
  ref_: AssessmentRef;
  secure: boolean;
  title: string;
  caption: string;
  maxMarks: number;
  rows: readonly AssessmentMarkRowDto[];
  editable: boolean;
  readOnlyReason: string;
  banner: React.ReactNode;
  onReload: () => void;
}) {
  const refKey = 'serverId' in ref_ ? `s:${ref_.serverId}` : `l:${ref_.localId}`;
  const local = useLocalQuery(queryKeys.localMarks(refKey), () => readLocalMarks(ref_));
  const locals = new Map((local.data ?? []).map((m) => [m.enrolmentId, m]));
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const valueOf = (row: AssessmentMarkRowDto) => rowValue(row, locals.get(row.enrolmentId));
  const draftFor = (row: AssessmentMarkRowDto) => drafts[row.enrolmentId] ?? draftOf(valueOf(row));
  const edit = (row: AssessmentMarkRowDto, patch: Partial<Draft>) =>
    setDrafts((previous) => ({ ...previous, [row.enrolmentId]: { ...draftFor(row), ...patch } }));
  const pending = marksToSave(rows, drafts, locals, maxMarks);

  const all = local.data ?? [];
  const elsewhere = all.filter((m) => m.state === 'changed_elsewhere');
  const failed = all.find((m) => m.outbox?.state === 'failed') ?? null;
  const latest = [...all].reverse().find((m) => m.state !== 'changed_elsewhere') ?? null;
  const state =
    latest === null
      ? null
      : latest.state === 'waiting'
        ? { kind: 'device' as const, retryInMinutes: null }
        : localState(latest.outbox, latest.state === 'done' ? latest.updatedAt : null);
  const remedy = failed?.outbox ? remedyFor('marks_enter', failed.outbox.responseCode) : null;

  async function save() {
    setSaveError(null);
    setErrors(pending.errors);
    if (Object.keys(pending.errors).length > 0 || pending.marks.length === 0) return;
    try {
      await saveMarks(ref_, pending.marks);
    } catch (error) {
      log('warn', 'marks.save_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      setSaveError('Could not save on this phone. Try again.');
      return;
    }
    log('info', 'marks.saved_on_device', { marks: pending.marks.length });
    setDrafts({});
    await local.refetch();
    void outboxWorker.trigger('enqueued');
  }

  const nameOf = (m: LocalAssessmentMark) =>
    rows.find((r) => r.enrolmentId === m.enrolmentId)?.student.fullName ?? 'A student';

  const header = (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.caption}>{caption}</Text>
      {state !== null ? <StateLine state={state} testID="marks.stateLine" /> : null}
      {!editable ? <Text style={styles.caption}>{readOnlyReason}</Text> : null}
      {elsewhere.length > 0 ? (
        <Banner
          tone="warning"
          text={`Changed elsewhere: ${elsewhere.map(nameOf).join(', ')}. Your mark was not saved; theirs is shown. Enter yours again to replace it.`}
          actionLabel="Reload"
          onAction={() =>
            void dropChangedElsewhere(ref_).then(() => {
              onReload();
              void local.refetch();
            })
          }
          testID="marks.changedElsewhere"
        />
      ) : null}
      {failed !== null && remedy !== null ? (
        <Banner
          tone="warning"
          text={`Not saved: ${failed.outbox?.responseMessage ?? 'refused'}`}
          actionLabel={remedy === 'edit_resend' ? 'Discard and enter again' : 'Discard'}
          onAction={() => {
            if (failed.outbox) void discardItem(failed.outbox.id).then(() => local.refetch());
          }}
          testID="marks.failed"
        />
      ) : null}
    </View>
  );

  return (
    <Screen
      title="Marks"
      accessory={<SyncChip />}
      banner={banner}
      scroll={false}
      secure={secure}
      testID="marks.grid.screen"
      footer={
        editable && rows.length > 0 ? (
          <>
            <Text style={styles.counts} testID="marks.counts">
              {markedLine(rows, (row) => valueOf(row))}
              {pending.marks.length > 0 ? ` · ${pending.marks.length} to save` : ''}
            </Text>
            {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
            <Button
              label="Save marks"
              onPress={() => void save()}
              disabled={pending.marks.length === 0}
              testID="marks.save"
            />
          </>
        ) : null
      }
    >
      <FlatList
        data={rows}
        keyExtractor={(row) => row.enrolmentId}
        initialNumToRender={20}
        ListHeaderComponent={header}
        ListEmptyComponent={<EmptyState title="No students on this test." />}
        keyboardShouldPersistTaps="handled"
        testID="marks.grid"
        renderItem={({ item: row }) => {
          const draft = draftFor(row);
          const mine = locals.get(row.enrolmentId);
          return (
            <View style={styles.row} testID={`marks.row.${row.enrolmentId}`}>
              <Text style={styles.roll}>{row.student.rollNo ?? '–'}</Text>
              <View style={styles.name}>
                <Text style={styles.body}>{row.student.fullName}</Text>
                {row.excused ? <Text style={styles.caption}>excused</Text> : null}
                {mine?.state === 'changed_elsewhere' ? (
                  <Text style={styles.caption}>changed elsewhere</Text>
                ) : null}
                {errors[row.enrolmentId] ? (
                  <Text style={styles.error}>{errors[row.enrolmentId]}</Text>
                ) : null}
              </View>
              <TextInput
                style={[styles.input, draft.absent && styles.inputOff]}
                value={draft.absent ? '' : draft.text}
                onChangeText={(text) => edit(row, { text, absent: false })}
                editable={editable && !draft.absent}
                keyboardType="number-pad"
                maxLength={4}
                accessibilityLabel={`Mark of ${row.student.fullName}`}
                testID={`marks.input.${row.enrolmentId}`}
              />
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: draft.absent, disabled: !editable }}
                accessibilityLabel={`${row.student.fullName} absent`}
                disabled={!editable}
                onPress={() => edit(row, { absent: !draft.absent })}
                style={[styles.absent, draft.absent && styles.absentOn]}
                testID={`marks.absent.${row.enrolmentId}`}
              >
                <Text style={[styles.absentText, draft.absent && styles.absentTextOn]}>Absent</Text>
              </Pressable>
            </View>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.xs, paddingVertical: space.sm },
  title: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  counts: { fontSize: fontSize.small, color: colors.foreground },
  error: { fontSize: fontSize.small, color: colors.destructive },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: TAP_TARGET + 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  roll: { width: 28, fontSize: fontSize.small, color: colors.mutedForeground },
  name: { flex: 1, gap: 2 },
  body: { fontSize: fontSize.body, color: colors.foreground },
  input: {
    width: 64,
    minHeight: TAP_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    paddingHorizontal: space.sm,
    fontSize: fontSize.body,
    color: colors.foreground,
    textAlign: 'center',
  },
  inputOff: { backgroundColor: colors.muted },
  absent: {
    minHeight: TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
  },
  absentOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  absentText: { fontSize: fontSize.small, color: colors.foreground },
  absentTextOn: { color: colors.primaryForeground },
});
