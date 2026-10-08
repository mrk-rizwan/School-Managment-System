import { useLocalSearchParams } from 'expo-router';
import { FamilyResultsScreen } from '../../../../../family/FamilyResults';

// /children/[studentId]/results (slice 33): a child's published results and class tests. Secure.
export default function ChildResultsRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FamilyResultsScreen source={{ kind: 'child', studentId }} secure />;
}
