import { useLocalSearchParams } from 'expo-router';
import { StudentsScreen } from '../../../../../remarks/StudentsScreen';

// /classes/[sectionId]/students (slice-16 §4.6). Children's names: secure.
export default function StudentsRoute() {
  const { sectionId } = useLocalSearchParams<{ sectionId: string }>();
  return <StudentsScreen sectionId={sectionId} secure />;
}
