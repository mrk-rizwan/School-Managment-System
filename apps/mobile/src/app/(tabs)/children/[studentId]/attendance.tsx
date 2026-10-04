import { useLocalSearchParams } from 'expo-router';
import { FamilyAttendanceScreen } from '../../../../family/FamilyScreens';

// /children/[studentId]/attendance (slice-16 §5). A child's name: secure.
export default function ChildAttendanceRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FamilyAttendanceScreen source={{ kind: 'child', studentId }} secure />;
}
