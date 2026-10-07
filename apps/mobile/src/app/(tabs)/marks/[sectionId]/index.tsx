import { useLocalSearchParams } from 'expo-router';
import { SectionAssessmentsScreen } from '../../../../marks/SectionAssessmentsScreen';

// /marks/[sectionId] — the section's tests and exams (plan §3.8). Not secure: no child's name.
export default function SectionAssessmentsRoute() {
  const { sectionId, classId } = useLocalSearchParams<{ sectionId: string; classId?: string }>();
  return <SectionAssessmentsScreen sectionId={sectionId} classId={classId ?? null} />;
}
