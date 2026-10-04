import { useLocalSearchParams } from 'expo-router';
import { SectionDiaryScreen } from '../../../../../diary/SectionDiaryScreen';

// /classes/[sectionId]/diary (slice-16 §4.4). No child's name: not secure.
export default function SectionDiaryRoute() {
  const { sectionId, classId } = useLocalSearchParams<{ sectionId: string; classId?: string }>();
  return <SectionDiaryScreen sectionId={sectionId} classId={classId} />;
}
