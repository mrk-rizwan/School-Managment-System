import { useLocalSearchParams } from 'expo-router';
import { FamilyEventsScreen } from '../../../../events/EventScreens';

// /children/[studentId]/events (slice 38): the events the child's section is invited to. Not
// secure: the DTO carries no child's name and the screen shows none.
export default function ChildEventsRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FamilyEventsScreen source={{ kind: 'child', studentId }} />;
}
