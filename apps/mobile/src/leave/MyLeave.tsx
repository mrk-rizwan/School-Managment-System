import { formatDay, newIdempotencyKey, todayInSchool } from '@asms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrap } from '../api/client';
import type { LeaveRequestDto } from '../api/contracts';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { Paging } from '../ui/Paging';
import { ReasonSheet } from '../ui/ReasonSheet';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import {
  balanceLine,
  canCancel,
  fetchBalance,
  fetchRequests,
  fetchTypes,
  formProblems,
  LEAVE_LIMIT,
  leaveFailure,
  leaveKeys,
  pickableDays,
  requestLine,
  statusWord,
  type LeaveForm,
} from './my-leave';

// My leave (slice 24, R226): the Home card and /home/my-leave. Online only: offline the screen
// shows nothing stale and says it needs a connection. The user's own data: not a secure screen.

/** The Home card: opens My leave. Reads nothing, so it costs no request on Home. */
export function MyLeaveCard() {
  const router = useRouter();
  return (
    <Sheet testID="home.myLeave">
      <ListRow
        title="My leave"
        detail="Balances and requests"
        onPress={() => router.push('/home/my-leave')}
        testID="home.myLeave.open"
      />
    </Sheet>
  );
}

export function MyLeaveScreen() {
  const online = useOnline();
  const client = useQueryClient();
  const requestGate = useOnlineOnly('request_leave');
  const cancelGate = useOnlineOnly('cancel_leave');
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [cancelling, setCancelling] = useState<LeaveRequestDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const today = todayInSchool();

  const balance = useQuery({ queryKey: leaveKeys.balance, queryFn: fetchBalance, enabled: online });
  const requests = useQuery({
    queryKey: leaveKeys.requests(page),
    queryFn: () => fetchRequests(page),
    enabled: online,
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: leaveKeys.all });
  };

  async function cancel(row: LeaveRequestDto, reason: string) {
    setBusy(true);
    setMessage(null);
    try {
      await unwrap(
        api.POST('/api/v1/me/staff/leave-requests/{id}/cancel', {
          params: { path: { id: row.id } },
          body: { reason },
        }),
      );
      setCancelling(null);
      setMessage('Request cancelled.');
      refresh();
    } catch (error) {
      setCancelling(null);
      setMessage(leaveFailure(error));
    } finally {
      setBusy(false);
    }
  }

  if (!online) {
    return (
      <Screen title="My leave" testID="myLeave.screen">
        <EmptyState
          title="Needs a connection"
          description="Leave is read and requested online only. Connect and open this again."
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="My leave"
      testID="myLeave.screen"
      onRefresh={refresh}
      footer={
        <Button
          label="Request leave"
          onPress={() => setFormOpen(true)}
          disabled={!requestGate.enabled}
          testID="myLeave.request"
        />
      }
    >
      {message !== null ? (
        <Text style={styles.message} testID="myLeave.message">
          {message}
        </Text>
      ) : null}
      <Text style={styles.heading}>Balance {balance.data ? balance.data.year : ''}</Text>
      {balance.isPending ? (
        <LoadingState />
      ) : balance.isError ? (
        <ErrorState error={balance.error} onRetry={() => void balance.refetch()} />
      ) : (
        <Sheet testID="myLeave.balance">
          {balance.data.types.map((row) => (
            <ListRow
              key={row.leaveTypeId}
              title={row.name}
              detail={balanceLine(row)}
              testID={`myLeave.balance.${row.leaveTypeId}`}
            />
          ))}
        </Sheet>
      )}
      <Text style={styles.heading}>Requests</Text>
      {requests.isPending ? (
        <LoadingState />
      ) : requests.isError ? (
        <ErrorState error={requests.error} onRetry={() => void requests.refetch()} />
      ) : requests.data.data.length === 0 ? (
        <EmptyState title="No requests yet" description="Requests you make appear here." />
      ) : (
        <>
          <Sheet testID="myLeave.requests">
            {requests.data.data.map((row) => (
              <ListRow
                key={row.id}
                title={`${row.leaveType.name} · ${statusWord(row.status)}`}
                detail={requestLine(row)}
                value={canCancel(row, today) ? (cancelGate.enabled ? 'Cancel' : cancelGate.reason) : null}
                onPress={canCancel(row, today) && cancelGate.enabled ? () => setCancelling(row) : undefined}
                testID={`myLeave.request.${row.id}`}
              />
            ))}
          </Sheet>
          <Paging
            page={page}
            limit={LEAVE_LIMIT}
            total={requests.data.total}
            onPage={setPage}
            testID="myLeave.paging"
          />
        </>
      )}
      {formOpen ? (
        <RequestLeaveSheet
          today={today}
          onClose={() => setFormOpen(false)}
          onCreated={() => {
            setFormOpen(false);
            setMessage('Request sent. You are told when it is decided.');
            setPage(1);
            refresh();
          }}
        />
      ) : null}
      <ReasonSheet
        visible={cancelling !== null}
        title="Cancel this request?"
        changes={cancelling ? [`${cancelling.leaveType.name}: ${requestLine(cancelling)}`] : []}
        confirmLabel="Cancel the request"
        busy={busy}
        disabledReason={cancelGate.reason}
        onConfirm={(reason) => {
          if (cancelling) void cancel(cancelling, reason);
        }}
        onClose={() => setCancelling(null)}
      />
    </Screen>
  );
}

/** The request form: one key per opening of the form (a retried send replays, never duplicates). */
function RequestLeaveSheet({
  today,
  onClose,
  onCreated,
}: {
  today: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const gate = useOnlineOnly('request_leave');
  const types = useQuery({ queryKey: leaveKeys.types, queryFn: fetchTypes });
  const [key] = useState(newIdempotencyKey);
  const [form, setForm] = useState<LeaveForm>({ leaveTypeId: null, startsOn: today, endsOn: today, reason: '' });
  const [picking, setPicking] = useState<'startsOn' | 'endsOn' | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const problems = formProblems(form, today);
    setErrors(problems);
    if (Object.keys(problems).length > 0 || form.leaveTypeId === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await unwrap(
        api.POST('/api/v1/me/staff/leave-requests', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            leaveTypeId: form.leaveTypeId,
            startsOn: form.startsOn,
            endsOn: form.endsOn,
            reason: form.reason.trim(),
          },
        }),
      );
      onCreated();
    } catch (error) {
      setFailure(leaveFailure(error));
    } finally {
      setBusy(false);
    }
  }

  if (picking !== null) {
    return (
      <ModalSheet
        visible
        title={picking === 'endsOn' ? 'Last day' : 'First day'}
        onClose={() => setPicking(null)}
        testID="leaveForm.days"
      >
        {pickableDays(today).map((date) => (
          <ListRow
            key={date}
            title={date === today ? `Today, ${formatDay(date)}` : formatDay(date)}
            value={form[picking] === date ? 'Chosen' : null}
            onPress={() => {
              setForm(
                picking === 'startsOn'
                  ? { ...form, startsOn: date, endsOn: form.endsOn < date ? date : form.endsOn }
                  : { ...form, endsOn: date },
              );
              setPicking(null);
            }}
            testID={`leaveForm.day.${date}`}
          />
        ))}
      </ModalSheet>
    );
  }

  return (
    <ModalSheet
      visible
      title="Request leave"
      onClose={onClose}
      testID="leaveForm"
      footer={
        <Button
          label={gate.enabled ? 'Send request' : (gate.reason ?? 'Needs a connection')}
          onPress={() => void submit()}
          disabled={!gate.enabled}
          busy={busy}
          testID="leaveForm.send"
        />
      }
    >
      {types.isPending ? (
        <LoadingState />
      ) : types.isError ? (
        <ErrorState error={types.error} onRetry={() => void types.refetch()} />
      ) : (
        <SegmentedPicker
          label="Type"
          options={types.data.data.map((t) => ({ value: t.id, label: t.name }))}
          value={form.leaveTypeId}
          onChange={(leaveTypeId) => setForm({ ...form, leaveTypeId })}
          testID="leaveForm.type"
        />
      )}
      {errors.leaveTypeId ? <Text style={styles.error}>{errors.leaveTypeId}</Text> : null}
      <ListRow
        title="First day"
        value={formatDay(form.startsOn)}
        detail={errors.startsOn ?? null}
        onPress={() => setPicking('startsOn')}
        testID="leaveForm.startsOn"
      />
      <ListRow
        title="Last day"
        value={formatDay(form.endsOn)}
        detail={errors.endsOn ?? null}
        onPress={() => setPicking('endsOn')}
        testID="leaveForm.endsOn"
      />
      <Field
        label="Reason"
        value={form.reason}
        onChangeText={(reason) => setForm({ ...form, reason })}
        error={errors.reason ?? null}
        multiline
        maxLength={500}
        testID="leaveForm.reason"
      />
      {failure !== null ? (
        <Text style={styles.error} testID="leaveForm.failure">
          {failure}
        </Text>
      ) : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: fontSize.small, fontWeight: '600', color: colors.mutedForeground, marginTop: space.sm },
  message: { fontSize: fontSize.body, color: colors.foreground },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
