import { useLocalSearchParams } from 'expo-router';
import { DepositSlipScreen } from '../../../../fees/DepositSlipScreen';

// /children/[studentId]/deposit-slip (phase-3-financial.md §3.9, R199): offline-capable. A child's
// name in the title: secure.
export default function DepositSlipRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <DepositSlipScreen studentId={studentId} secure />;
}
