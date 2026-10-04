import { useLocalSearchParams } from 'expo-router';
import { DiaryComposeScreen } from '../../../../../diary/DiaryComposeScreen';

// /classes/[sectionId]/diary/new (slice-16 §4.4). No child's name: not secure.
export default function DiaryComposeRoute() {
  const { sectionId, classId, resend } = useLocalSearchParams<{
    sectionId: string;
    classId?: string;
    resend?: string;
  }>();
  return (
    <DiaryComposeScreen sectionId={sectionId} classId={classId ?? null} resend={resend ?? null} />
  );
}
