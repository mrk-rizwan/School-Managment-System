import { useLocalSearchParams } from 'expo-router';
import { FamilyResultCardScreen } from '../../../../../family/FamilyResults';

// /children/[studentId]/results/[resultId] (slice 33): a child's report card. Secure.
export default function ChildResultCardRoute() {
  const { studentId, resultId } = useLocalSearchParams<{ studentId: string; resultId: string }>();
  return <FamilyResultCardScreen source={{ kind: 'child', studentId }} resultId={resultId} secure />;
}
