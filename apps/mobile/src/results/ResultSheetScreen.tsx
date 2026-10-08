import { formatPercentLabel, TERM_REMARK_MAX } from '@asms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrap } from '../api/client';
import type { ResultSheetDetailDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { ReasonSheet } from '../ui/ReasonSheet';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import {
  fetchSheet,
  ownChildNote,
  rowLine,
  sheetFailure,
  sheetTitle,
  STATUS_WORDS,
} from './results';

// The writes, each behind its useOnlineOnly gate below (R162).
const saveRemarks = (id: string, remarks: { enrolmentId: string; remark: string | null }[]) =>
  unwrap(api.PATCH('/api/v1/result-sheets/{id}', { params: { path: { id } }, body: { remarks } }));
const submitSheet = (id: string) =>
  unwrap(api.POST('/api/v1/result-sheets/{id}/submit', { params: { path: { id } } }));
const approveSheet = (id: string) =>
  unwrap(api.POST('/api/v1/result-sheets/{id}/approve', { params: { path: { id } } }));
const publishSheet = (id: string) =>
  unwrap(api.POST('/api/v1/result-sheets/{id}/publish', { params: { path: { id } } }));
const returnSheet = (id: string, reason: string) =>
  unwrap(
    api.POST('/api/v1/result-sheets/{id}/return', { params: { path: { id } }, body: { reason } }),
  );

// One result sheet on the phone (phase-4-academic.md slice 31, §3.8): the preview (the shared
// composition over the live marks until approval, then the stored results), the class teacher's
// remarks and submit, the principal's approve, return and publish — each shown only when the
// server says the caller may (canRemark, canSubmit, canDecide, canPublish). Online only; secure.

export function ResultSheetScreen({ id, secure }: { id: string; secure: boolean }) {
  const online = useOnline();
  const sheet = useQuery({
    queryKey: queryKeys.resultSheet(id),
    queryFn: () => fetchSheet(id),
    enabled: online,
  });
  // Kept above the view, which remounts with each new version of the sheet.
  const [message, setMessage] = useState<string | null>(null);
  if (!online) {
    return (
      <Screen title="Result sheet" secure={secure} testID="sheet.screen">
        <EmptyState
          title="Needs a connection"
          description="Result sheets are read and decided online only. Connect and open this again."
        />
      </Screen>
    );
  }
  if (sheet.isPending) {
    return (
      <Screen title="Result sheet" secure={secure} testID="sheet.screen">
        <LoadingState />
      </Screen>
    );
  }
  if (sheet.isError) {
    return (
      <Screen title="Result sheet" secure={secure} testID="sheet.screen">
        <ErrorState error={sheet.error} onRetry={() => void sheet.refetch()} />
      </Screen>
    );
  }
  return (
    <SheetView
      key={sheet.data.updatedAt}
      data={sheet.data}
      message={message}
      setMessage={setMessage}
      secure={secure}
      onRefresh={() => void sheet.refetch()}
    />
  );
}

function SheetView({
  data,
  message,
  setMessage,
  secure,
  onRefresh,
}: {
  data: ResultSheetDetailDto;
  message: string | null;
  setMessage: (message: string | null) => void;
  secure: boolean;
  onRefresh: () => void;
}) {
  const client = useQueryClient();
  const [remarks, setRemarks] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const submitGate = useOnlineOnly('submit_result_sheet');
  const decideGate = useOnlineOnly('approve_result_sheet');
  const remarkGate = useOnlineOnly('save_result_remarks');
  const publishGate = useOnlineOnly('publish_result_sheet');
  const returnGate = useOnlineOnly('return_result_sheet');

  const changed = [...remarks].filter(([enrolmentId, text]) => {
    const row = data.preview.find((r) => r.enrolmentId === enrolmentId);
    return (row?.remark ?? '') !== text.trim();
  });

  async function run(send: () => Promise<ResultSheetDetailDto>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await send();
      client.setQueryData(queryKeys.resultSheet(data.id), next);
      void client.invalidateQueries({ queryKey: queryKeys.approvals });
      setRemarks(new Map());
      setMessage(done);
    } catch (error) {
      const failure = sheetFailure(error);
      setMessage(failure.message);
      if (failure.stale) onRefresh();
    } finally {
      setBusy(false);
    }
  }

  const ownChild = ownChildNote(data);
  return (
    <Screen
      title={sheetTitle(data)}
      secure={secure}
      testID="sheet.screen"
      onRefresh={onRefresh}
      footer={
        <View style={styles.footer}>
          {data.canRemark && changed.length > 0 ? (
            <Button
              label={`Save remarks (${changed.length})`}
              variant="secondary"
              busy={busy}
              disabled={!remarkGate.enabled}
              onPress={() =>
                void run(
                  () =>
                    saveRemarks(
                      data.id,
                      changed.map(([enrolmentId, text]) => ({
                        enrolmentId,
                        remark: text.trim() === '' ? null : text.trim(),
                      })),
                    ),
                  'Remarks saved.',
                )
              }
              testID="sheet.saveRemarks"
            />
          ) : null}
          {data.canSubmit ? (
            <Button
              label="Submit for approval"
              busy={busy}
              disabled={!submitGate.enabled || changed.length > 0}
              onPress={() => void run(() => submitSheet(data.id), 'Submitted for approval.')}
              testID="sheet.submit"
            />
          ) : null}
          {data.canDecide && data.status !== 'approved' ? (
            <Button
              label="Approve"
              busy={busy}
              disabled={!decideGate.enabled}
              onPress={() => void run(() => approveSheet(data.id), 'Approved.')}
              testID="sheet.approve"
            />
          ) : null}
          {data.canPublish ? (
            <Button
              label="Publish"
              busy={busy}
              disabled={!publishGate.enabled}
              onPress={() =>
                void run(() => publishSheet(data.id), 'Published. Families are being told.')
              }
              testID="sheet.publish"
            />
          ) : null}
          {data.canDecide && (data.status === 'submitted' || data.status === 'approved') ? (
            <Button
              label="Return…"
              variant="secondary"
              disabled={!returnGate.enabled || busy}
              onPress={() => setReturning(true)}
              testID="sheet.return"
            />
          ) : null}
        </View>
      }
    >
      <Text style={styles.status} testID="sheet.status">
        {STATUS_WORDS[data.status]}
        {data.submittedByName
          ? ` · submitted by ${data.submittedByName}${data.cover ? ' (covering)' : ''}`
          : ''}
      </Text>
      {message !== null ? (
        <Text style={styles.message} testID="sheet.message">
          {message}
        </Text>
      ) : null}
      {data.status === 'returned' && data.returnReason ? (
        <Text
          style={styles.warning}
          testID="sheet.returnReason"
        >{`Returned: ${data.returnReason}`}</Text>
      ) : null}
      {ownChild ? (
        <Text style={styles.warning} testID="sheet.ownChild">
          {ownChild}
        </Text>
      ) : null}
      {data.selfApproved ? (
        <Text style={styles.note}>
          Approved by its own submitter, the school&apos;s only principal.
        </Text>
      ) : null}
      {data.source === 'preview' && data.flags.missingCount > 0 ? (
        <Text style={styles.warning} testID="sheet.missing">
          {`${data.flags.missingCount} ${data.flags.missingCount === 1 ? 'mark is' : 'marks are'} missing.`}
        </Text>
      ) : null}
      <Text style={styles.note}>
        {data.source === 'preview'
          ? 'A preview from the marks so far. Nothing is stored until approval.'
          : 'The stored results.'}
      </Text>
      {data.preview.length === 0 ? (
        <EmptyState title="No students on this sheet" />
      ) : (
        <Sheet title={`Students · ${data.preview.length}`}>
          {data.preview.map((row) => (
            <View key={row.enrolmentId} style={styles.row}>
              <ListRow
                title={`${row.rollNo !== null ? `${row.rollNo}. ` : ''}${row.fullName}`}
                detail={rowLine(row)}
                value={
                  formatPercentLabel(row.attendanceBp) === '—' ? null : `Att. ${formatPercentLabel(row.attendanceBp)}`
                }
                testID={`sheet.row.${row.enrolmentId}`}
              />
              {data.canRemark ? (
                <Field
                  label={`Remark for ${row.fullName}`}
                  value={remarks.get(row.enrolmentId) ?? row.remark ?? ''}
                  onChangeText={(text) => setRemarks(new Map(remarks).set(row.enrolmentId, text))}
                  maxLength={TERM_REMARK_MAX}
                  multiline
                  testID={`sheet.remark.${row.enrolmentId}`}
                />
              ) : row.remark ? (
                <Text style={styles.note}>{row.remark}</Text>
              ) : null}
            </View>
          ))}
        </Sheet>
      )}
      <ReasonSheet
        visible={returning}
        title="Return the sheet"
        changes={[`${sheetTitle(data)}. The class teacher sees your reason; the tests unlock.`]}
        confirmLabel="Return sheet"
        busy={busy}
        disabledReason={returnGate.reason}
        onConfirm={(reason) => {
          setReturning(false);
          void run(() => returnSheet(data.id, reason), 'Returned to the class teacher.');
        }}
        onClose={() => setReturning(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { gap: space.sm },
  row: { gap: space.xs, paddingBottom: space.sm },
  status: { fontSize: fontSize.body, fontWeight: '600', color: colors.foreground },
  message: { fontSize: fontSize.body, color: colors.foreground },
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  warning: { fontSize: fontSize.small, color: colors.destructive },
});
