import { useLocalSearchParams } from 'expo-router';
import { FamilyTransportScreen } from '../../../../transport/TransportScreens';

// /children/[studentId]/transport (slice 41, R330): the child's route, stop, pickup time and
// driver. Not secure: the DTO carries no child's name and the screen shows none.
export default function ChildTransportRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FamilyTransportScreen source={{ kind: 'child', studentId }} />;
}
