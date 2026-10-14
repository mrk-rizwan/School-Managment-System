import { useLocalSearchParams } from 'expo-router';
import { StaffEventScreen } from '../../../../events/EventScreens';

// /classes/events/[id] (Phase 5 slice 38): an event's roster names children. Secure.
export default function StaffEventRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StaffEventScreen id={id} secure />;
}
