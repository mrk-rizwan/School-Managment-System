import { DEFAULT_TIMEZONE, todayInSchool } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type {
  AttendanceMarkDto,
  RegisterViewDto,
  RosterRowDto,
  SubmitRegisterDto,
} from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { readRegister, discardItem, resendWithRemedy, saveRegister } from '../db/local.repository';
import { findItem } from '../db/outbox.repository';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { buildRegisterBody } from '../outbox/bodies';
import { remedyFor } from '../outbox/lanes';
import { outboxWorker, useLocalQuery } from '../outbox/runtime';
import { log } from '../platform/log';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { DateSheet } from '../ui/DateSheet';
import { Field } from '../ui/Field';
import { ModalSheet } from '../ui/ModalSheet';
import { ReasonSheet } from '../ui/ReasonSheet';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { localState, StateLine } from '../ui/StateLine';
import { NoDataState, OfflineNotice } from '../ui/states';
import { StatusChip } from '../ui/StatusChip';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize, space, TAP_TARGET } from '../ui/theme';
import { AmendMarkSheet } from './AmendMarkSheet';
import { MarkHistory } from './MarkHistory';
import {
  amendmentLines,
  countOf,
  countsLine,
  differsFromServer,
  editable,
  isClockTime,
  localMarksApply,
  marksToSend,
  namelessLine,
  nextStatus,
  registerMode,
  rowValue,
  STATUS_WORDS,
  type Edits,
  type RegisterMode,
  type RowValue,
} from './register-model';

// The register — /classes/[sectionId]/register?date&period (slice-16 §4.2). Offline-capable:
// the server's view (cached per section, date and period) overlaid with the device's own marks;
// Save writes the local register and its outbox row in one transaction and says so. "Saved on
// server" appears only after the server's 2xx (R157).

export const ROW_HEIGHT = 56;

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: DEFAULT_TIMEZONE,
});

const BANNERS: Partial<Record<RegisterMode, string>> = {
  locked: 'The amendment window closed. Ask the principal.',
  not_teaching: 'Not a teaching day.',
};

type Props = { sectionId: string; date?: string; period?: number; secure?: boolean };

export function RegisterScreen({
  sectionId,
  date: initialDate,
  period: initialPeriod,
  secure,
}: Props) {
  const online = useOnline();
  const client = useQueryClient();
  const [date, setDate] = useState(initialDate ?? todayInSchool());
  const [period, setPeriod] = useState(initialPeriod ?? 1);
  const [edits, setEdits] = useState<Edits>({});
  const [dateOpen, setDateOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [rowOpen, setRowOpen] = useState<RosterRowDto | null>(null);
  const [amendOpen, setAmendOpen] = useState<RosterRowDto | null>(null);
  const [remedyOpen, setRemedyOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const historyGate = useOnlineOnly('amend_mark');

  const view = useCachedQuery<RegisterViewDto>(
    queryKeys.register(sectionId, date, period),
    `/api/v1/sections/${sectionId}/register`,
    { date, period },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/sections/{id}/register', {
          params: { path: { id: sectionId }, query: { date, period } },
        }),
      ),
  );
  const local = useLocalQuery(queryKeys.localRegister(sectionId, date, period), () =>
    readRegister(sectionId, date, period),
  );
  const localRegister = local.data ?? null;
  const cached = view.data;
  const registerView = cached?.body ?? null;

  const state = localRegister
    ? localState(localRegister.outbox, localRegister.savedOnServerAt)
    : null;
  const stateLine = state ? <StateLine state={state} testID="register.stateLine" /> : null;

  // No view on the device. After a 401 wiped the cache, an unsent register still says what it
  // holds — counts, never names (slice-16 §3.4).
  if (registerView === null) {
    return (
      <Screen title="Register" accessory={<SyncChip />} secure={secure} testID="register.screen">
        {localRegister !== null ? (
          <View style={styles.nameless} testID="register.nameless">
            <Text style={styles.body}>{namelessLine(localRegister)}</Text>
            {stateLine}
          </View>
        ) : (
          <NoDataState
            isError={view.isError}
            error={view.error}
            onRetry={() => void view.refetch()}
            offlineMessage="Cannot load this register offline. Open it once while connected."
          />
        )}
      </Screen>
    );
  }

  const mode = registerMode(registerView);
  const canEdit = editable(mode);
  const useLocal = localMarksApply(localRegister, registerView);
  const valueOf = (row: RosterRowDto): RowValue =>
    rowValue(row, mode, edits, localRegister, useLocal);
  const rows = registerView.roster;
  const counts = countOf(rows.filter((r) => r.onRoster).map((r) => valueOf(r).status));
  const changed =
    mode === 'amend' ? rows.filter((r) => r.onRoster && differsFromServer(r, valueOf(r))) : [];
  const failed = localRegister?.outbox?.state === 'failed' ? localRegister.outbox : null;
  const remedy = failed ? remedyFor('submit_register', failed.responseCode) : null;

  function edit(row: RosterRowDto, patch: Partial<RowValue>) {
    setEdits((previous) => ({ ...previous, [row.enrolmentId]: { ...valueOf(row), ...patch } }));
  }

  function cycle(row: RosterRowDto) {
    const next = nextStatus(valueOf(row).status);
    edit(row, { status: next, arrivedAt: next === 'late' ? valueOf(row).arrivedAt : null });
  }

  async function save(reason: string | null) {
    if (registerView === null) return;
    setSaveError(null);
    const marks = marksToSend(registerView, mode, valueOf);
    try {
      await saveRegister({
        sectionId,
        date,
        period,
        mode: mode === 'amend' ? 'amend' : 'new',
        marks,
        reason,
      });
    } catch (error) {
      setSaveError(
        error instanceof Error && error.name === 'SensitiveTextError'
          ? 'A note or the reason has an identity number or a phone number. Remove it and save again.'
          : 'Could not save on this phone. Try again.',
      );
      return;
    }
    log('info', 'register.saved_on_device', { sectionId, date, period, marks: marks.length });
    setEdits({});
    setReasonOpen(false);
    await local.refetch();
    if (online) void outboxWorker.trigger('enqueued');
  }

  function onSave() {
    if (mode === 'amend') {
      if (changed.length === 0) return;
      setReasonOpen(true);
      return;
    }
    void save(null);
  }

  async function applyRemedy(reason?: string) {
    if (failed === null) return;
    const item = await findItem(failed.id);
    if (item === null) return;
    const stored = JSON.parse(item.body) as SubmitRegisterDto;
    try {
      if (remedy === 'add_reason' && reason !== undefined) {
        await resendWithRemedy(item, buildRegisterBody({ ...stored, reason }));
      } else if (remedy === 'reload') {
        // Refetch the roster, lay the device's marks over it; missing enrolments are present.
        const fresh = await view.refetch();
        const roster = fresh.data?.body.roster ?? rows;
        const localMarks = new Map((localRegister?.marks ?? []).map((m) => [m.enrolmentId, m]));
        const marks = roster
          .filter((row) => row.onRoster)
          .map(
            (row) =>
              localMarks.get(row.enrolmentId) ?? {
                enrolmentId: row.enrolmentId,
                status: 'present' as const,
              },
          );
        await resendWithRemedy(item, buildRegisterBody({ ...stored, marks }));
      } else if (remedy === 'retry') {
        await resendWithRemedy(item);
      } else {
        await discardItem(item.id);
      }
    } catch (error) {
      setSaveError(
        error instanceof Error && error.name === 'SensitiveTextError'
          ? 'The reason has an identity number or a phone number. Remove it and try again.'
          : 'Could not save on this phone. Try again.',
      );
      return;
    }
    setRemedyOpen(false);
    await local.refetch();
    if (online) void outboxWorker.trigger('enqueued');
  }

  const nameOf = (enrolmentId: string) =>
    rows.find((r) => r.enrolmentId === enrolmentId)?.studentFullName ?? 'A student';
  const changeLines = changed.map((row) => {
    const from = row.mark ? STATUS_WORDS[row.mark.status] : 'not marked';
    const to = valueOf(row).status;
    return `${row.studentFullName}: ${from} → ${to ? STATUS_WORDS[to] : 'not marked'}`;
  });
  const register = registerView.register;

  const header = (
    <View style={styles.header}>
      <Text style={styles.title}>
        {`${registerView.section.className} ${registerView.section.name}`}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => setDateOpen(true)}
        style={styles.dateButton}
        testID="register.date"
      >
        <Text style={styles.link}>{date === todayInSchool() ? `Today, ${date}` : date}</Text>
      </Pressable>
      {registerView.section.attendanceMode === 'period' ? (
        <SegmentedPicker
          label="Period"
          options={Array.from({ length: registerView.periodsPerDay }, (_, i) => ({
            value: String(i + 1),
            label: String(i + 1),
          }))}
          value={String(period)}
          onChange={(value) => {
            setPeriod(Number(value));
            setEdits({});
          }}
          testID="register.period"
        />
      ) : null}
      {register ? (
        <Text style={styles.caption} testID="register.recordedBy">
          {`Recorded by ${register.submittedByName ?? 'staff'} at ${timeFormat.format(new Date(register.submittedAt))}`}
          {register.lastAmendedByName ? ` · Amended by ${register.lastAmendedByName}` : ''}
        </Text>
      ) : null}
      {mode === 'viewer' ? <Text style={styles.caption}>Viewing only</Text> : null}
      {stateLine}
      {localRegister?.summary && state?.kind === 'server' ? (
        <Text style={styles.caption} testID="register.summary">
          {countsLine(localRegister.summary)}
        </Text>
      ) : null}
      {failed && remedy ? (
        <Button
          label={
            remedy === 'add_reason'
              ? 'Add a reason and resend'
              : remedy === 'reload'
                ? 'Reload and save again'
                : remedy === 'retry'
                  ? 'Try again'
                  : 'Discard'
          }
          variant={remedy === 'discard' ? 'destructive' : 'secondary'}
          onPress={() => (remedy === 'add_reason' ? setRemedyOpen(true) : void applyRemedy())}
          testID="register.remedy"
        />
      ) : null}
    </View>
  );

  const banner = (
    <View style={styles.banners}>
      {!online || view.isError ? (
        <OfflineNotice serverTime={cached!.serverTime} isDevice={cached!.serverTimeIsDevice} />
      ) : null}
      {BANNERS[mode] ? (
        <Banner tone="warning" text={BANNERS[mode]} testID="register.banner" />
      ) : null}
    </View>
  );

  return (
    <Screen
      title="Register"
      accessory={<SyncChip />}
      banner={banner}
      scroll={false}
      secure={secure}
      testID="register.screen"
      footer={
        canEdit ? (
          <>
            <Text style={styles.counts} testID="register.counts">
              {countsLine(counts)}
            </Text>
            {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
            <Button
              label="Save register"
              onPress={onSave}
              disabled={mode === 'amend' && changed.length === 0}
              testID="register.save"
            />
          </>
        ) : null
      }
    >
      <FlatList
        data={rows}
        keyExtractor={(row) => row.enrolmentId}
        initialNumToRender={20}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        ListHeaderComponent={header}
        testID="register.roster"
        renderItem={({ item: row }) => {
          const value = valueOf(row);
          const rowEditable = canEdit && row.onRoster;
          const isChanged = mode === 'amend' && differsFromServer(row, value);
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${row.studentFullName}: ${value.status ? STATUS_WORDS[value.status] : 'not marked'}`}
              onPress={rowEditable ? () => cycle(row) : () => setRowOpen(row)}
              onLongPress={() => setRowOpen(row)}
              style={styles.row}
              testID={`register.row.${row.enrolmentId}`}
            >
              <Text style={styles.roll}>{row.rollNo ?? '–'}</Text>
              <View style={styles.name}>
                <Text style={styles.body}>{row.studentFullName}</Text>
                {!row.onRoster ? <Text style={styles.caption}>left</Text> : null}
                {isChanged ? <Text style={styles.caption}>changed</Text> : null}
              </View>
              <StatusChip
                status={value.status}
                onPress={rowEditable ? () => cycle(row) : () => setRowOpen(row)}
                onLongPress={() => setRowOpen(row)}
                testID={`register.chip.${row.enrolmentId}`}
              />
            </Pressable>
          );
        }}
      />

      <DateSheet
        visible={dateOpen}
        today={todayInSchool()}
        value={date}
        onClose={() => setDateOpen(false)}
        onPick={(picked) => {
          setDate(picked);
          setEdits({});
          setDateOpen(false);
        }}
      />

      <ReasonSheet
        visible={reasonOpen}
        changes={changeLines}
        onClose={() => setReasonOpen(false)}
        onConfirm={(reason) => void save(reason)}
      />

      <ReasonSheet
        visible={remedyOpen}
        title="Add a reason and resend"
        changes={[
          'Changed since you loaded:',
          // The server's own list of what this save would change (kept on the outbox row);
          // the device's marks only when an older row has none.
          ...(amendmentLines(failed?.responseDetails ?? null, nameOf) ??
            (localRegister?.marks ?? []).map(
              (m) => `${nameOf(m.enrolmentId)}: ${STATUS_WORDS[m.status]}`,
            )),
        ]}
        confirmLabel="Resend with this reason"
        onClose={() => setRemedyOpen(false)}
        onConfirm={(reason) => void applyRemedy(reason)}
      />

      <RowSheet
        row={rowOpen}
        value={rowOpen ? valueOf(rowOpen) : null}
        editable={rowOpen !== null && canEdit && rowOpen.onRoster}
        canAmendOnline={
          rowOpen !== null && rowOpen.mark !== null && registerView.amendable && historyGate.enabled
        }
        online={historyGate.enabled}
        onChange={(patch) => rowOpen && edit(rowOpen, patch)}
        onAmend={() => {
          setAmendOpen(rowOpen);
          setRowOpen(null);
        }}
        onClose={() => setRowOpen(null)}
      />

      <AmendMarkSheet
        visible={amendOpen !== null}
        mark={amendOpen?.mark ?? null}
        studentName={amendOpen?.studentFullName ?? ''}
        onClose={() => setAmendOpen(null)}
        onStale={() => void view.refetch()}
        onAmended={(mark: AttendanceMarkDto) => {
          // The row updates from the DTO; the register is refetched when online.
          client.setQueryData(queryKeys.register(sectionId, date, period), (old: typeof cached) =>
            old === undefined
              ? old
              : {
                  ...old,
                  body: {
                    ...old.body,
                    roster: old.body.roster.map((r) =>
                      r.enrolmentId === mark.enrolmentId ? { ...r, mark } : r,
                    ),
                  },
                },
          );
          void client.invalidateQueries({ queryKey: queryKeys.register(sectionId, date, period) });
        }}
      />
    </Screen>
  );
}

/** Long-press: the row's note, arrival time, history, and the online per-mark amend. */
function RowSheet({
  row,
  value,
  editable: canEdit,
  canAmendOnline,
  online,
  onChange,
  onAmend,
  onClose,
}: {
  row: RosterRowDto | null;
  value: RowValue | null;
  editable: boolean;
  canAmendOnline: boolean;
  online: boolean;
  onChange: (patch: Partial<RowValue>) => void;
  onAmend: () => void;
  onClose: () => void;
}) {
  const [noteError, setNoteError] = useState<string | null>(null);
  if (row === null || value === null) return null;
  return (
    <ModalSheet visible title={row.studentFullName} onClose={onClose} testID="register.rowSheet">
      <View style={styles.sheetRow}>
        <StatusChip status={value.status} />
        <Text style={styles.body}>{value.status ? STATUS_WORDS[value.status] : 'Not marked'}</Text>
        {row.mark?.amended ? <Text style={styles.caption}>amended</Text> : null}
      </View>
      {canEdit ? (
        <>
          <Field
            label="Note (optional)"
            value={value.note ?? ''}
            maxLength={200}
            error={noteError}
            onChangeText={(note) => {
              setNoteError(null);
              onChange({ note: note === '' ? null : note });
            }}
            testID="register.rowSheet.note"
          />
          {value.status === 'late' ? (
            <Field
              label="Arrived at (HH:MM)"
              value={value.arrivedAt ?? ''}
              maxLength={5}
              keyboardType="numbers-and-punctuation"
              error={
                value.arrivedAt && value.arrivedAt.length === 5 && !isClockTime(value.arrivedAt)
                  ? 'Use HH:MM, for example 08:40.'
                  : null
              }
              onChangeText={(arrivedAt) =>
                onChange({ arrivedAt: arrivedAt === '' ? null : arrivedAt })
              }
              testID="register.rowSheet.arrivedAt"
            />
          ) : null}
        </>
      ) : value.note ? (
        <Text style={styles.body}>{value.note}</Text>
      ) : null}
      {row.mark !== null ? (
        online ? (
          <MarkHistory markId={row.mark.id} />
        ) : (
          <Text style={styles.caption}>Mark history needs a connection</Text>
        )
      ) : null}
      {row.mark !== null ? (
        <Button
          label="Amend this mark"
          variant="secondary"
          disabled={!canAmendOnline}
          onPress={onAmend}
          testID="register.rowSheet.amend"
        />
      ) : null}
      {row.mark !== null && !online ? <Text style={styles.caption}>Needs a connection</Text> : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.sm, paddingBottom: space.md },
  banners: { gap: space.sm },
  title: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  dateButton: { minHeight: TAP_TARGET, justifyContent: 'center' },
  link: { fontSize: fontSize.body, color: colors.primary, fontWeight: '600' },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  body: { fontSize: fontSize.body, color: colors.foreground },
  error: { fontSize: fontSize.small, color: colors.destructive },
  counts: { fontSize: fontSize.body, fontWeight: '600', color: colors.foreground },
  nameless: { gap: space.sm },
  row: {
    minHeight: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  roll: { width: 32, fontSize: fontSize.small, color: colors.mutedForeground },
  name: { flex: 1 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
