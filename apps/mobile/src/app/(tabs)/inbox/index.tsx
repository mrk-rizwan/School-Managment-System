import { useSession } from '../../../auth/session';
import { InboxScreen } from '../../../inbox/InboxScreen';

// /inbox (slice-16 §7.3): everyone's messages. The screen sets `secure` from the user's
// capacities: a guardian's rows name their children.
export default function InboxRoute() {
  const { me } = useSession();
  return <InboxScreen secure={me?.body.capacities.includes('guardian') ?? false} />;
}
