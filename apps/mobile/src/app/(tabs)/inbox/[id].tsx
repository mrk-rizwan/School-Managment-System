import { useLocalSearchParams } from 'expo-router';
import { useSession } from '../../../auth/session';
import { InboxItemScreen } from '../../../inbox/InboxItemScreen';

// /inbox/[id] (slice-16 §7.3): one message; push deep links land here. The screen sets `secure`
// from the user's capacities.
export default function InboxItemRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useSession();
  return <InboxItemScreen id={id} secure={me?.body.capacities.includes('guardian') ?? false} />;
}
