import { Capability } from '@asms/shared';
import { useRouter } from 'expo-router';
import { useSession } from '../auth/session';
import { holds } from '../auth/capabilities';
import { ListRow } from '../ui/ListRow';
import { Sheet } from '../ui/Sheet';

// The Home card of an expense.record holder (phase-3-financial.md §3.9): opens the expenses
// recorded on this phone, where a new one is captured, offline too.
export function ExpensesCard() {
  const router = useRouter();
  const { me } = useSession();
  if (me === null || !holds(me.body, Capability.EXPENSE_RECORD)) return null;
  return (
    <Sheet testID="home.expenses">
      <ListRow
        title="Expenses"
        detail="Record an expense and photograph its receipt"
        onPress={() => router.push('/home/expenses')}
        testID="home.expenses.open"
      />
    </Sheet>
  );
}
