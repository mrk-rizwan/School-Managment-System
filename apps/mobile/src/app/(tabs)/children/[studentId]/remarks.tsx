import { useLocalSearchParams } from 'expo-router';
import { FamilyRemarksScreen } from '../../../../family/FamilyScreens';

// /children/[studentId]/remarks (slice-16 §5). A child's name: secure.
export default function ChildRemarksRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FamilyRemarksScreen source={{ kind: 'child', studentId }} secure />;
}
