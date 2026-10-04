import { Redirect } from 'expo-router';
import { useSession, type SessionStatus } from '../auth/session';
import { LoadingState } from '../ui/states';

const ROUTE = {
  'signed-in': '/home',
  'signed-out': '/sign-in',
  blocked: '/update-required',
  'no-access': '/no-access',
  unreachable: '/unreachable',
} as const satisfies Record<Exclude<SessionStatus, 'starting'>, string>;

/** "/" goes wherever the session is. */
export default function Index() {
  const { status } = useSession();
  if (status === 'starting') return <LoadingState />;
  return <Redirect href={ROUTE[status]} />;
}
