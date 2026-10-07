import { useLocalSearchParams } from 'expo-router';
import { NewTestScreen } from '../../../../marks/NewTestScreen';

// /marks/[sectionId]/new — a new class test (plan §3.8). Not secure: no child's name.
export default function NewTestRoute() {
  const { sectionId, classId, resend } = useLocalSearchParams<{
    sectionId: string;
    classId?: string;
    resend?: string;
  }>();
  return <NewTestScreen sectionId={sectionId} classId={classId ?? null} resend={resend ?? null} />;
}
