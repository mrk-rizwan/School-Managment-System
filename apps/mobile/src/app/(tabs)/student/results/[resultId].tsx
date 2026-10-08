import { useLocalSearchParams } from 'expo-router';
import { FamilyResultCardScreen } from '../../../../family/FamilyResults';

// /student/results/[resultId] (slice 33): the student's own report card. Secure.
export default function OwnResultCardRoute() {
  const { resultId } = useLocalSearchParams<{ resultId: string }>();
  return <FamilyResultCardScreen source={{ kind: 'own' }} resultId={resultId} secure />;
}
