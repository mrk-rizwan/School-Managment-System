import { formatDay, todayInSchool } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CounterPaymentMethod, RecordableExpenseCategory } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { listLocalExpenses, saveExpense, type LocalPhoto } from '../db/local.repository';
import { deleteOutboxFile } from '../media/files';
import { pickPhoto } from '../media/picker';
import { sensitiveTextError } from '../outbox/bodies';
import { outboxWorker } from '../outbox/runtime';
import { log } from '../platform/log';
import { Button } from '../ui/Button';
import { DateSheet } from '../ui/DateSheet';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { colors, fontSize, space } from '../ui/theme';
import { CATEGORY_OPTIONS, METHOD_LABELS } from './labels';

// A new expense — /home/expenses/new (phase-3-financial.md §3.9, R207). Saved on the device in
// one transaction with its outbox row (the outbox id is the Idempotency-Key); a photographed
// receipt waits in its own row and is sent after the expense reaches the server. No child's
// name: not secure. Above the school's approval threshold the server records it as waiting for
// approval (a principal's own is approved on record); the phone does not know the threshold.

/** The server's bound on an amount (MAX_RUPEES). */
const MAX_AMOUNT = 10_000_000;

export function ExpenseComposeScreen({ resend = null }: { resend?: string | null }) {
  const router = useRouter();
  const client = useQueryClient();
  const today = todayInSchool();
  const [category, setCategory] = useState<RecordableExpenseCategory | null>(null);
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState(today);
  const [description, setDescription] = useState('');
  const [payee, setPayee] = useState('');
  const [method, setMethod] = useState<CounterPaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState<LocalPhoto | null>(null);
  const [keepsReceipt, setKeepsReceipt] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (resend === null) return;
    void listLocalExpenses().then((expenses) => {
      const expense = expenses.find((e) => e.id === resend);
      if (expense === undefined) return;
      setCategory(expense.category as RecordableExpenseCategory);
      setAmount(String(expense.amount));
      setSpentOn(expense.spentOn);
      setDescription(expense.description);
      setPayee(expense.payee ?? '');
      setMethod(expense.method as CounterPaymentMethod);
      setReference(expense.reference ?? '');
      setKeepsReceipt(expense.receipt?.state === 'waiting');
    });
  }, [resend]);

  async function chooseReceipt(source: 'camera' | 'library') {
    setMessage(null);
    const result = await pickPhoto(source);
    if (result.kind === 'refused') setMessage(result.message);
    if (result.kind === 'picked') {
      if (receipt !== null) deleteOutboxFile(receipt.fileName);
      setReceipt(result.photo);
    }
  }

  async function save() {
    const problems: Record<string, string> = {};
    if (category === null) problems.category = 'Choose a category.';
    const rupees = /^[0-9]+$/.test(amount.trim()) ? Number(amount.trim()) : Number.NaN;
    if (!Number.isSafeInteger(rupees) || rupees < 1) problems.amount = 'Enter whole rupees, 1 or more.';
    else if (rupees > MAX_AMOUNT) problems.amount = 'At most 10,000,000.';
    const text = description.trim();
    if (text.length < 1) problems.description = 'Say what it was for.';
    else if (text.length > 500) problems.description = 'At most 500 characters.';
    if (payee.trim().length > 100) problems.payee = 'At most 100 characters.';
    if (reference.trim().length > 60) problems.reference = 'At most 60 characters.';
    for (const [field, value] of [
      ['description', description],
      ['payee', payee],
      ['reference', reference],
    ] as const) {
      const problem = sensitiveTextError(value);
      if (problem) problems[field] = problem;
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0 || category === null) return;
    setBusy(true);
    try {
      await saveExpense(
        { category, amount: rupees, spentOn, description, payee, method, reference },
        receipt,
        new Date(),
        resend,
      );
      log('info', 'expense.saved_on_device', { receipt: receipt !== null });
      void client.invalidateQueries({ queryKey: queryKeys.local });
      void outboxWorker.trigger('enqueued');
      router.back();
    } catch (error) {
      log('warn', 'expense.save_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      setMessage('Could not save on this phone. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title={resend ? 'Edit and resend' : 'New expense'}
      testID="expenseCompose.screen"
      footer={
        <Button label="Save expense" busy={busy} onPress={() => void save()} testID="expenseCompose.save" />
      }
    >
      <SegmentedPicker
        label="Category"
        options={CATEGORY_OPTIONS}
        value={category}
        onChange={setCategory}
        testID="expenseCompose.category"
      />
      {errors.category ? <Text style={styles.error}>{errors.category}</Text> : null}
      <Field
        label="Amount (Rs)"
        value={amount}
        onChangeText={setAmount}
        keyboardType="number-pad"
        maxLength={8}
        error={errors.amount}
        testID="expenseCompose.amount"
      />
      <ListRow
        title="Spent on"
        value={spentOn === today ? `Today, ${formatDay(spentOn)}` : formatDay(spentOn)}
        onPress={() => setDateOpen(true)}
        testID="expenseCompose.spentOn"
      />
      <Field
        label="What for"
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={500}
        error={errors.description}
        testID="expenseCompose.description"
      />
      <Field
        label="Paid to (optional)"
        value={payee}
        onChangeText={setPayee}
        maxLength={100}
        error={errors.payee}
        testID="expenseCompose.payee"
      />
      <SegmentedPicker
        label="Paid by"
        options={Object.entries(METHOD_LABELS).map(([value, label]) => ({
          value: value as CounterPaymentMethod,
          label,
        }))}
        value={method}
        onChange={setMethod}
        testID="expenseCompose.method"
      />
      <Field
        label="Bill or reference number (optional)"
        value={reference}
        onChangeText={setReference}
        maxLength={60}
        error={errors.reference}
        testID="expenseCompose.reference"
      />
      <View style={styles.receipt}>
        <Text style={styles.label}>Receipt (optional)</Text>
        {receipt !== null ? (
          <Text style={styles.caption} testID="expenseCompose.receiptChosen">
            {`Receipt photographed (${Math.round(receipt.sizeBytes / 1024)} KB) — sent after the expense`}
          </Text>
        ) : keepsReceipt ? (
          <Text style={styles.caption}>The receipt from before is kept.</Text>
        ) : null}
        <View style={styles.buttons}>
          <Button
            label="Photograph receipt"
            variant="secondary"
            onPress={() => void chooseReceipt('camera')}
            testID="expenseCompose.camera"
          />
          <Button
            label="Choose photo"
            variant="secondary"
            onPress={() => void chooseReceipt('library')}
            testID="expenseCompose.library"
          />
        </View>
      </View>
      {message ? (
        <Text style={styles.error} testID="expenseCompose.message">
          {message}
        </Text>
      ) : null}
      <DateSheet
        visible={dateOpen}
        title="Spent on"
        today={today}
        value={spentOn}
        onClose={() => setDateOpen(false)}
        onPick={(picked) => {
          setSpentOn(picked);
          setDateOpen(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { fontSize: fontSize.small, color: colors.destructive },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  receipt: { gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
