import { useLocalSearchParams } from 'expo-router';
import { FamilyDiaryScreen } from '../../../../family/FamilyScreens';

// /children/[studentId]/diary (slice-16 §5). A child's name: secure.
export default function ChildDiaryRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FamilyDiaryScreen source={{ kind: 'child', studentId }} secure />;
}
