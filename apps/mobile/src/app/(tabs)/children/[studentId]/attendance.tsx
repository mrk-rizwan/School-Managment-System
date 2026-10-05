import { useLocalSearchParams } from 'expo-router';
import { AttendanceMonthScreen } from '../../../../family/FamilyScreens';

// /children/[studentId]/attendance (slice-16 §5). A child's name: secure.
export default function ChildAttendanceRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <AttendanceMonthScreen source={{ kind: 'child', studentId }} secure />;
}
