import { useLocalSearchParams } from 'expo-router';
import { FeesScreen } from '../../../../fees/FeesScreen';

// /children/[studentId]/fees (phase-3-financial.md slice 21, §3.9). A child's name: secure.
export default function ChildFeesRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FeesScreen studentId={studentId} secure />;
}
