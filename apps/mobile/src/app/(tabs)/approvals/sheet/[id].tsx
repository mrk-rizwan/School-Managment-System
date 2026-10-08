import { useLocalSearchParams } from 'expo-router';
import { ResultSheetScreen } from '../../../../results/ResultSheetScreen';

// /approvals/sheet/[id] — a result sheet waiting for the principal (slice 31): preview, approve,
// return. Online only; secure.
export default function ApprovalsSheetRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ResultSheetScreen id={id} secure />;
}
