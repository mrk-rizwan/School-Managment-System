import { useLocalSearchParams } from 'expo-router';
import { ExpenseComposeScreen } from '../../../../expenses/ExpenseComposeScreen';

// /home/expenses/new (phase-3-financial.md §3.9, R207): a new expense, offline-capable. Not secure.
export default function ExpenseComposeRoute() {
  const { resend } = useLocalSearchParams<{ resend?: string }>();
  return <ExpenseComposeScreen resend={resend ?? null} />;
}
