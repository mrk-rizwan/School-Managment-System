import { useLocalSearchParams } from 'expo-router';
import { StudentSheetScreen } from '../../../../../remarks/StudentSheetScreen';

// /classes/[sectionId]/students/[studentId] (slice-16 §4.6). A child's name: secure.
export default function StudentSheetRoute() {
  const { sectionId, studentId } = useLocalSearchParams<{ sectionId: string; studentId: string }>();
  return <StudentSheetScreen sectionId={sectionId} studentId={studentId} secure />;
}
