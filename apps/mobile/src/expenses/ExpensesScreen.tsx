import { EXPENSE_CATEGORY_LABELS, formatDay, formatRupees, type ExpenseCategory } from '@asms/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { queryKeys } from '../api/query-keys';
import { discardItem, listLocalExpenses, type LocalExpense } from '../db/local.repository';
import { remedyFor } from '../outbox/lanes';
import { useLocalQuery } from '../outbox/runtime';
import { Button } from '../ui/Button';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { localState, StateLine } from '../ui/StateLine';
import { SyncChip } from '../ui/SyncChip';
import { EmptyState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import { serverStatusLabel } from './labels';

// Expenses recorded on this phone — /home/expenses (phase-3-financial.md §3.9, R207): each with
// its state line, its receipt's state, the number and status the server gave it, and the remedy
// of a refused one. Approving and voiding are on the web console (and the principal's Approvals
// tab, slice 27); they are online-only and never queued (R226). Not secure: no child's name.

export function ExpensesScreen() {
  const router = useRouter();
  const local = useLocalQuery([...queryKeys.local, 'expenses'], listLocalExpenses);
  const [open, setOpen] = useState<LocalExpense | null>(null);
  const expenses = local.data ?? [];

  function discard(expense: LocalExpense) {
    const outboxId = expense.outbox?.id;
    if (outboxId === undefined) return;
    Alert.alert('Discard this expense?', 'It has not reached the school and will be lost.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () =>
          void discardItem(outboxId).then(() => {
            setOpen(null);
            return local.refetch();
          }),
      },
    ]);
  }

  const remedyOf = (expense: LocalExpense) =>
    expense.outbox?.state === 'failed' ? remedyFor('expense', expense.outbox.responseCode) : null;

  const receiptLine = (expense: LocalExpense): string | null => {
    const receipt = expense.receipt;
    if (receipt === null) return null;
    if (receipt.state === 'waiting') return 'Receipt: waiting for the expense';
    if (receipt.state === 'done') return 'Receipt: saved on server';
    if (receipt.outbox?.state === 'failed') return `Receipt not saved: ${receipt.outbox.responseMessage ?? 'refused'}`;
    return 'Receipt: queued';
  };

  return (
    <Screen
      title="Expenses"
      accessory={<SyncChip />}
      testID="expenses.screen"
      footer={
        <Button
          label="New expense"
          onPress={() => router.push('/home/expenses/new')}
          testID="expenses.new"
        />
      }
    >
      {expenses.length === 0 ? (
        <EmptyState title="No expenses recorded on this phone." />
      ) : (
        <Sheet title="On this phone" testID="expenses.local">
          {expenses.map((expense) => (
            <View key={expense.id} style={styles.row}>
              <ListRow
                title={`${formatRupees(expense.amount)} · ${
                  EXPENSE_CATEGORY_LABELS[expense.category as ExpenseCategory] ?? expense.category
                }`}
                detail={[
                  formatDay(expense.spentOn),
                  expense.expenseNo === null ? null : `No. ${expense.expenseNo}`,
                  serverStatusLabel(expense.serverStatus),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onPress={() => setOpen(expense)}
                testID={`expenses.local.${expense.id}`}
              />
              <StateLine
                state={localState(expense.outbox, expense.savedOnServerAt)}
                testID={`expenses.local.${expense.id}.state`}
              />
              {receiptLine(expense) ? (
                <Text style={styles.caption} testID={`expenses.local.${expense.id}.receipt`}>
                  {receiptLine(expense)}
                </Text>
              ) : null}
            </View>
          ))}
        </Sheet>
      )}

      <ModalSheet
        visible={open !== null}
        title="Expense"
        onClose={() => setOpen(null)}
        testID="expenses.sheet"
      >
        {open ? (
          <View style={styles.sheet}>
            <Text style={styles.body}>{open.description}</Text>
            {open.payee ? <Text style={styles.caption}>{`Paid to ${open.payee}`}</Text> : null}
            {open.reference ? <Text style={styles.caption}>{`Reference ${open.reference}`}</Text> : null}
            <StateLine state={localState(open.outbox, open.savedOnServerAt)} testID="expenses.sheet.state" />
            {remedyOf(open) === 'edit_resend' ? (
              <Button
                label="Edit and resend"
                variant="secondary"
                onPress={() => {
                  setOpen(null);
                  router.push({ pathname: '/home/expenses/new', params: { resend: open.id } });
                }}
                testID="expenses.remedy.edit"
              />
            ) : null}
            {open.outbox && open.outbox.state !== 'sending' && open.outbox.state !== 'done' ? (
              <Button
                label="Discard"
                variant="destructive"
                onPress={() => discard(open)}
                testID="expenses.remedy.discard"
              />
            ) : null}
          </View>
        ) : null}
      </ModalSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { paddingBottom: space.sm },
  sheet: { gap: space.sm },
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
