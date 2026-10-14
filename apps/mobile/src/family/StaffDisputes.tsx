import {
  ATTENDANCE_STATUS_LABELS,
  DISPUTE_STATUS_LABELS,
  formatDay,
  newIdempotencyKey,
  STAFF_ATTENDANCE_STATUSES,
  type StaffAttendanceStatus,
} from '@asms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrap } from '../api/client';
import type { MyStaffAttendanceDayDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { decisionFailure } from '../approvals/approvals';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { reasonError } from '../ui/ReasonSheet';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { Sheet } from '../ui/Sheet';
import { colors, fontSize } from '../ui/theme';

// Phase 5 slice 44 (contracts/slice-44.md §2.5, R346): a staff member disputes a mark of their own
// with a reason; a colleague who manages staff attendance decides. Online only: nothing waits in
// the outbox, the disputes are never cached, and the Idempotency-Key lives in the sheet's state.

/** The month's marked days, each with its dispute and a Dispute action; then the latest disputes. */
export function StaffDisputes({ days }: { days: readonly MyStaffAttendanceDayDto[] }) {
  const online = useOnline();
  const client = useQueryClient();
  const withdrawGate = useOnlineOnly('withdraw_attendance_dispute');
  const [raising, setRaising] = useState<MyStaffAttendanceDayDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disputes = useQuery({
    queryKey: queryKeys.myDisputes,
    queryFn: () => unwrap(api.GET('/api/v1/me/staff/attendance-disputes', { params: { query: { page: 1, limit: 10 } } })),
    enabled: online,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: queryKeys.myDisputes });
    void client.invalidateQueries({ queryKey: ['me', 'staff', 'attendance'] });
  };
  // A month cached before slice 44 carries no markId: such a day cannot be disputed until re-read.
  const marked = days.filter((d) => d.status !== null && typeof d.markId === 'string');

  async function withdraw(id: string) {
    setBusy(true);
    try {
      await unwrap(api.POST('/api/v1/me/staff/attendance-disputes/{id}/withdraw', { params: { path: { id } } }));
      setMessage('Dispute withdrawn.');
    } catch (error) {
      setMessage(decisionFailure(error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  }

  return (
    <>
      {message !== null ? (
        <Text style={styles.message} testID="myDisputes.message">
          {message}
        </Text>
      ) : null}
      {marked.length > 0 ? (
        <Sheet title="Dispute a day" testID="myDisputes.days">
          {marked.map((d) => {
            const pending = d.disputeStatus === 'pending';
            return (
              <ListRow
                key={d.date}
                title={formatDay(d.date)}
                detail={`${ATTENDANCE_STATUS_LABELS[d.status!]}${d.source === 'device' ? ' · by the device' : ''}`}
                value={d.disputeStatus ? `Dispute ${DISPUTE_STATUS_LABELS[d.disputeStatus].toLowerCase()}` : online ? 'Dispute' : null}
                onPress={pending || !online ? undefined : () => setRaising(d)}
                testID={`myDisputes.day.${d.date}`}
              />
            );
          })}
          {!online ? <Text style={styles.note}>Needs a connection to dispute a day.</Text> : null}
        </Sheet>
      ) : null}
      {online && disputes.data && disputes.data.data.length > 0 ? (
        <Sheet title="My disputes" testID="myDisputes.list">
          {disputes.data.data.map((d) => (
            <ListRow
              key={d.id}
              title={`${formatDay(d.date)}: ${ATTENDANCE_STATUS_LABELS[d.markStatus]} → ${ATTENDANCE_STATUS_LABELS[d.requestedStatus]}`}
              detail={
                d.status === 'pending'
                  ? 'Pending. Tap to withdraw.'
                  : `${DISPUTE_STATUS_LABELS[d.status]}${d.decisionReason ? `: ${d.decisionReason}` : ''}`
              }
              value={DISPUTE_STATUS_LABELS[d.status]}
              onPress={d.status === 'pending' && withdrawGate.enabled && !busy ? () => void withdraw(d.id) : undefined}
              testID={`myDisputes.dispute.${d.id}`}
            />
          ))}
        </Sheet>
      ) : null}
      {raising ? (
        <RaiseDisputeSheet
          key={raising.date}
          day={raising}
          onClose={() => setRaising(null)}
          onSent={() => {
            setRaising(null);
            setMessage('Dispute sent. You will be told the decision.');
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

function RaiseDisputeSheet({
  day,
  onClose,
  onSent,
}: {
  day: MyStaffAttendanceDayDto;
  onClose: () => void;
  onSent: () => void;
}) {
  const gate = useOnlineOnly('raise_attendance_dispute');
  // One key per opening: a retried send replays instead of raising twice.
  const [key] = useState(newIdempotencyKey);
  const options = STAFF_ATTENDANCE_STATUSES.filter((s) => s !== day.status).map((value) => ({
    value,
    label: ATTENDANCE_STATUS_LABELS[value],
  }));
  const [requested, setRequested] = useState<StaffAttendanceStatus | null>(options[0]?.value ?? null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const invalid = reasonError(reason);
    setError(invalid);
    if (invalid !== null || requested === null || day.markId === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await unwrap(
        api.POST('/api/v1/me/staff/attendance-disputes', {
          params: { header: { 'Idempotency-Key': key } },
          body: { attendanceId: day.markId, requestedStatus: requested, reason: reason.trim() },
        }),
      );
      onSent();
    } catch (caught) {
      setFailure(decisionFailure(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSheet
      visible
      title={`Dispute ${formatDay(day.date)}`}
      onClose={onClose}
      testID="myDisputes.sheet"
      footer={
        <>
          {failure !== null ? (
            <Text style={styles.error} testID="myDisputes.failure">
              {failure}
            </Text>
          ) : null}
          {gate.reason ? <Text style={styles.note}>{gate.reason}</Text> : null}
          <Button label="Send dispute" onPress={() => void send()} disabled={!gate.enabled} busy={busy} testID="myDisputes.send" />
        </>
      }
    >
      <Text style={styles.body}>{`It says ${ATTENDANCE_STATUS_LABELS[day.status!]}. A colleague decides.`}</Text>
      <SegmentedPicker label="It should say" options={options} value={requested} onChange={setRequested} testID="myDisputes.status" />
      <Field
        label="Reason"
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={500}
        error={error}
        testID="myDisputes.reason"
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  message: { fontSize: fontSize.body, color: colors.foreground },
  body: { fontSize: fontSize.body, color: colors.foreground },
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
