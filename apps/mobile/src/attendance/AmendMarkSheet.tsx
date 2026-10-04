import { ApiError, ATTENDANCE_STATUSES, ErrorCode, type AttendanceStatus } from '@asms/shared';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrap } from '../api/client';
import type { AttendanceMarkDto } from '../api/contracts';
import { useOnlineOnly } from '../net/connectivity';
import { sensitiveTextError } from '../outbox/bodies';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ModalSheet } from '../ui/ModalSheet';
import { reasonError } from '../ui/ReasonSheet';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { colors, fontSize } from '../ui/theme';
import { isClockTime, STATUS_WORDS } from './register-model';

// Amend one mark — online only (slice-16 §4.3, R162): POST /attendance-marks/:id/amend with the
// status the screen holds as fromStatus, so a stale phone never silently reverses a colleague
// (R125). Never enqueued.

const STATUS_OPTIONS = ATTENDANCE_STATUSES.map((status) => ({
  value: status,
  label: STATUS_WORDS[status].replace(/^./, (c) => c.toUpperCase()),
}));

export type AmendFailure =
  | { kind: 'stale'; message: string; currentStatus: AttendanceStatus | null }
  | { kind: 'closed'; message: string }
  | { kind: 'denied'; message: string }
  | { kind: 'invalid'; fields: Record<string, string>; message: string }
  | { kind: 'network'; message: string };

export function describeAmendError(error: unknown): AmendFailure {
  if (!(error instanceof ApiError)) {
    return { kind: 'network', message: 'No connection. Amending needs a connection.' };
  }
  if (error.code === ErrorCode.STALE_STATUS) {
    const current = (error.details as { currentStatus?: unknown } | null)?.currentStatus;
    const status = ATTENDANCE_STATUSES.find((s) => s === current) ?? null;
    return {
      kind: 'stale',
      currentStatus: status,
      message: `This mark was changed by a colleague${
        status ? ` to ${STATUS_WORDS[status]}` : ''
      }. Reload and amend again.`,
    };
  }
  if (error.code === ErrorCode.ATTENDANCE_LOCKED || error.code === ErrorCode.NOT_A_TEACHING_DAY) {
    return { kind: 'closed', message: error.message };
  }
  if (error.status === 403) {
    return { kind: 'denied', message: 'You cannot amend this mark. Ask the principal.' };
  }
  if (error.status === 422) {
    return {
      kind: 'invalid',
      message: error.message,
      fields: Object.fromEntries(error.fieldErrors.map((f) => [f.path, f.message])),
    };
  }
  return { kind: 'closed', message: error.message };
}

type Props = {
  visible: boolean;
  mark: AttendanceMarkDto | null;
  studentName: string;
  onClose: () => void;
  onAmended: (mark: AttendanceMarkDto) => void;
  /** A colleague changed it: the register reloads; the sheet stays open with the new status. */
  onStale: () => void;
};

/** Mounted only while open, so every opening starts from the mark as the screen holds it. */
export function AmendMarkSheet({ visible, mark, ...rest }: Props) {
  return visible && mark !== null ? (
    <OpenAmendMarkSheet key={mark.id} mark={mark} {...rest} />
  ) : null;
}

function OpenAmendMarkSheet({
  mark,
  studentName,
  onClose,
  onAmended,
  onStale,
}: Omit<Props, 'visible' | 'mark'> & { mark: AttendanceMarkDto }) {
  const gate = useOnlineOnly('amend_mark');
  const [fromStatus, setFromStatus] = useState<AttendanceStatus>(mark.status);
  const [status, setStatus] = useState<AttendanceStatus>(mark.status);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState(mark.note ?? '');
  const [noteTouched, setNoteTouched] = useState(false);
  const [arrivedAt, setArrivedAt] = useState(mark.arrivedAt ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit() {
    const problems: Record<string, string> = {};
    const reasonProblem = reasonError(reason);
    if (reasonProblem) problems.reason = reasonProblem;
    const noteProblem = sensitiveTextError(note);
    if (noteTouched && noteProblem) problems.note = noteProblem;
    if (status === 'late' && arrivedAt !== '' && !isClockTime(arrivedAt)) {
      problems.arrivedAt = 'Use HH:MM, for example 08:40.';
    }
    setFields(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const amended = await unwrap(
        api.POST('/api/v1/attendance-marks/{id}/amend', {
          params: { path: { id: mark.id } },
          body: {
            fromStatus,
            status,
            reason: reason.trim(),
            ...(noteTouched ? { note: note.trim() === '' ? null : note.trim() } : {}),
            ...(status === 'late' && arrivedAt !== '' ? { arrivedAt } : {}),
          },
        }),
      );
      onAmended(amended);
      onClose();
    } catch (error) {
      const outcome = describeAmendError(error);
      setMessage(outcome.message);
      if (outcome.kind === 'stale') {
        if (outcome.currentStatus !== null) setFromStatus(outcome.currentStatus);
        onStale();
      }
      if (outcome.kind === 'closed') onClose();
      if (outcome.kind === 'invalid') setFields(outcome.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSheet
      visible
      title={`Amend — ${studentName}`}
      onClose={onClose}
      testID="amendMark"
      footer={
        <>
          {gate.reason ? <Text style={styles.note}>{gate.reason}</Text> : null}
          <Button
            label="Amend mark"
            busy={busy}
            disabled={!gate.enabled}
            onPress={() => void submit()}
            testID="amendMark.submit"
          />
        </>
      }
    >
      <Text style={styles.note}>{`Now: ${STATUS_WORDS[fromStatus]}`}</Text>
      <SegmentedPicker
        label="New status"
        options={STATUS_OPTIONS}
        value={status}
        onChange={setStatus}
        testID="amendMark.status"
      />
      {status === 'late' ? (
        <Field
          label="Arrived at (HH:MM)"
          value={arrivedAt}
          onChangeText={setArrivedAt}
          keyboardType="numbers-and-punctuation"
          maxLength={5}
          error={fields.arrivedAt}
          testID="amendMark.arrivedAt"
        />
      ) : null}
      <Field
        label="Reason"
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={500}
        error={fields.reason}
        testID="amendMark.reason"
      />
      <Field
        label="Note (optional)"
        value={note}
        onChangeText={(text) => {
          setNote(text);
          setNoteTouched(true);
        }}
        maxLength={200}
        error={fields.note}
        testID="amendMark.note"
      />
      {message ? (
        <Text style={styles.error} testID="amendMark.message">
          {message}
        </Text>
      ) : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
