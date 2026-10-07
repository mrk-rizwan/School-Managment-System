import { DEPOSIT_METHODS, formatDay, PAYMENT_METHOD_LABELS, todayInSchool } from '@asms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DepositMethod } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import { saveClaim, type LocalPhoto } from '../db/local.repository';
import { deleteOutboxFile } from '../media/files';
import { pickPhoto } from '../media/picker';
import { useOnline } from '../net/connectivity';
import { sensitiveTextError } from '../outbox/bodies';
import { outboxWorker } from '../outbox/runtime';
import { log } from '../platform/log';
import { Button } from '../ui/Button';
import { DateSheet } from '../ui/DateSheet';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { Sheet } from '../ui/Sheet';
import { colors, fontSize, space } from '../ui/theme';
import { fetchAccounts } from './fees';

// Upload deposit slip — /children/[studentId]/deposit-slip (phase-3-financial.md §3.9, R199): saved
// on the device in one transaction with its outbox row (the outbox id is the Idempotency-Key) and
// the slip's file row; the slip is sent after the claim reaches the server, and deleted from the
// phone once the server has it. Works in airplane mode. Secure: the title is a child's name.

/** The server's bound on an amount (MAX_RUPEES). */
const MAX_AMOUNT = 10_000_000;
const METHOD_OPTIONS = DEPOSIT_METHODS.map((value) => ({
  value,
  label: PAYMENT_METHOD_LABELS[value],
}));

export function DepositSlipScreen({ studentId, secure }: { studentId: string; secure?: boolean }) {
  const router = useRouter();
  const client = useQueryClient();
  const online = useOnline();
  const { me } = useSession();
  const name = me?.body.children.find((c) => c.studentId === studentId)?.fullName ?? '';
  const today = todayInSchool();
  const accounts = useQuery({ queryKey: ['me', 'payment-accounts'], queryFn: fetchAccounts, enabled: online });
  const [method, setMethod] = useState<DepositMethod | null>(null);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [slip, setSlip] = useState<LocalPhoto | null>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The picked slip not yet saved with its claim: deleted from the phone when the screen goes
  // without saving (back, a session loss), so a child's slip never lingers outside the outbox.
  const unsaved = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (unsaved.current !== null) deleteOutboxFile(unsaved.current);
    },
    [],
  );

  async function chooseSlip(source: 'camera' | 'library') {
    setMessage(null);
    const result = await pickPhoto(source);
    if (result.kind === 'refused') setMessage(result.message);
    if (result.kind === 'picked') {
      if (slip !== null) deleteOutboxFile(slip.fileName);
      unsaved.current = result.photo.fileName;
      setSlip(result.photo);
    }
  }

  async function save() {
    const problems: Record<string, string> = {};
    if (method === null) problems.method = 'Choose how you paid.';
    const rupees = /^[0-9]+$/.test(amount.trim()) ? Number(amount.trim()) : Number.NaN;
    if (!Number.isSafeInteger(rupees) || rupees < 1) problems.amount = 'Enter whole rupees, 1 or more.';
    else if (rupees > MAX_AMOUNT) problems.amount = 'At most 10,000,000.';
    if (reference.trim().length > 60) problems.reference = 'At most 60 characters.';
    if (note.trim().length > 300) problems.note = 'At most 300 characters.';
    for (const [field, value] of [
      ['reference', reference],
      ['note', note],
    ] as const) {
      const problem = sensitiveTextError(value);
      if (problem) problems[field] = problem;
    }
    if (slip === null) problems.slip = 'Photograph the slip.';
    setErrors(problems);
    if (Object.keys(problems).length > 0 || method === null || slip === null) return;
    setBusy(true);
    try {
      await saveClaim(studentId, { method, claimedAmount: rupees, paidOn, reference, note }, slip, new Date());
      unsaved.current = null;
      log('info', 'claim.saved_on_device', {});
      void client.invalidateQueries({ queryKey: queryKeys.local });
      void outboxWorker.trigger('enqueued');
      router.back();
    } catch (error) {
      log('warn', 'claim.save_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      setMessage('Could not save on this phone. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title={name}
      secure={secure}
      testID="depositSlip.screen"
      footer={<Button label="Save slip" busy={busy} onPress={() => void save()} testID="depositSlip.save" />}
    >
      <Text style={styles.heading}>Upload deposit slip</Text>
      <Text style={styles.caption}>
        Paid at a bank or by wallet? Send the slip; the office checks it and the receipt follows. It is
        saved on this phone first and sent when there is a connection.
      </Text>
      {accounts.data && accounts.data.data.length > 0 ? (
        <Sheet title="The school's accounts" testID="depositSlip.accounts">
          {accounts.data.data.map((a) => (
            <ListRow key={a.id} title={a.accountNo} detail={[a.bankName, a.title].filter(Boolean).join(' · ')} />
          ))}
        </Sheet>
      ) : null}
      <SegmentedPicker label="Paid by" options={METHOD_OPTIONS} value={method} onChange={setMethod} testID="depositSlip.method" />
      {errors.method ? <Text style={styles.error}>{errors.method}</Text> : null}
      <Field
        label="Amount (Rs)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="number-pad"
        maxLength={8}
        error={errors.amount}
        testID="depositSlip.amount"
      />
      <ListRow
        title="Paid on"
        value={paidOn === today ? `Today, ${formatDay(paidOn)}` : formatDay(paidOn)}
        onPress={() => setDateOpen(true)}
        testID="depositSlip.paidOn"
      />
      <Field
        label="Transaction or slip number (optional)"
        value={reference}
        onChangeText={setReference}
        maxLength={60}
        error={errors.reference}
        testID="depositSlip.reference"
      />
      <Field
        label="Note (optional)"
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={300}
        error={errors.note}
        testID="depositSlip.note"
      />
      <View style={styles.slip}>
        <Text style={styles.label}>Slip</Text>
        {slip !== null ? (
          <Text style={styles.caption} testID="depositSlip.chosen">
            {`Slip photographed (${Math.round(slip.sizeBytes / 1024)} KB)`}
          </Text>
        ) : null}
        {errors.slip ? <Text style={styles.error}>{errors.slip}</Text> : null}
        <View style={styles.buttons}>
          <Button label="Photograph slip" variant="secondary" onPress={() => void chooseSlip('camera')} testID="depositSlip.camera" />
          <Button label="Choose photo" variant="secondary" onPress={() => void chooseSlip('library')} testID="depositSlip.library" />
        </View>
      </View>
      {message ? (
        <Text style={styles.error} testID="depositSlip.message">
          {message}
        </Text>
      ) : null}
      <DateSheet
        visible={dateOpen}
        title="Paid on"
        today={today}
        value={paidOn}
        onClose={() => setDateOpen(false)}
        onPick={(picked) => {
          setPaidOn(picked);
          setDateOpen(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  error: { fontSize: fontSize.small, color: colors.destructive },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  slip: { gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
