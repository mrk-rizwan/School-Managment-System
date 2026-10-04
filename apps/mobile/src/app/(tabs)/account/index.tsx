import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { revokeOtherSessions } from '../../../auth/account';
import { useSession } from '../../../auth/session';
import { useOnline } from '../../../net/connectivity';
import { useOutbox } from '../../../outbox/runtime';
import { readAppVersion } from '../../../platform/app-version';
import { ListRow } from '../../../ui/ListRow';
import { Screen } from '../../../ui/Screen';
import { Sheet } from '../../../ui/Sheet';
import { LoadingState } from '../../../ui/states';
import { colors, fontSize, space } from '../../../ui/theme';

// Account (slice-15 §4.4). Change password and "sign out other devices" are online-only (R162);
// change-email is web-only in Phase 2 and the screen says so.

export default function AccountScreen() {
  const router = useRouter();
  const session = useSession();
  const online = useOnline();
  const { items } = useOutbox();
  const [busy, setBusy] = useState(false);
  const me = session.me;
  if (me === null) return <LoadingState />;

  function revokeOthers() {
    Alert.alert(
      'Sign out other devices?',
      'Every other phone and browser signed in to your account is signed out.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out others',
          style: 'destructive',
          onPress: () => {
            void revokeOtherSessions().then((result) =>
              Alert.alert(
                result.ok ? `${result.revoked} signed out` : 'Not done',
                result.ok ? undefined : result.message,
              ),
            );
          },
        },
      ],
    );
  }

  async function signOut() {
    setBusy(true);
    const result = await session.signOut();
    setBusy(false);
    if (result === 'unreachable') {
      Alert.alert(
        'Could not reach the school',
        'Sign out anyway? This phone forgets the session now; on the school’s side it ends when it has been unused for its idle time.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign out anyway',
            style: 'destructive',
            onPress: () => void session.signOut({ force: true }),
          },
        ],
      );
    }
  }

  return (
    <Screen title="Account" testID="account.screen">
      <View style={styles.who}>
        <Text style={styles.name}>{me.body.fullName}</Text>
        <Text style={styles.detail}>{me.body.school.name}</Text>
      </View>
      <Sheet>
        <ListRow
          title="Change password"
          detail={online ? null : 'Needs a connection'}
          onPress={online ? () => router.push('/account/change-password') : undefined}
          testID="account.changePassword"
        />
        <ListRow title="Email" detail="Add or change your email on the web." />
        <ListRow
          title="Sync status"
          value={items.length === 0 ? 'All sent' : `${items.length} waiting`}
          onPress={() => router.push('/account/sync')}
          testID="account.sync"
        />
        <ListRow
          title="Diagnostics"
          onPress={() => router.push('/account/diagnostics')}
          testID="account.diagnostics"
        />
      </Sheet>
      <Sheet>
        <ListRow
          title="Sign out other devices"
          detail={online ? null : 'Needs a connection'}
          onPress={online ? revokeOthers : undefined}
          testID="account.revokeOthers"
        />
        <ListRow
          title={busy ? 'Signing out…' : 'Sign out'}
          destructive
          onPress={busy ? undefined : () => void signOut()}
          testID="account.signOut"
        />
      </Sheet>
      <Text style={styles.version}>Version {readAppVersion()}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  who: { gap: space.xs },
  name: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  detail: { fontSize: fontSize.small, color: colors.mutedForeground },
  version: { fontSize: fontSize.caption, color: colors.mutedForeground, textAlign: 'center' },
});
