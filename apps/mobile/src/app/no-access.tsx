import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useSession } from '../auth/session';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { colors, fontSize } from '../ui/theme';

// R156: a user with no capacity sees this and is signed out on dismiss.
export default function NoAccessScreen() {
  const { signOut } = useSession();
  const [busy, setBusy] = useState(false);

  async function dismiss() {
    setBusy(true);
    if ((await signOut()) === 'unreachable') await signOut({ force: true });
  }

  return (
    <Screen title="No access" testID="noAccess.screen">
      <Text style={styles.text}>Your account has no access to the app. Ask the office.</Text>
      <Button label="OK" busy={busy} onPress={() => void dismiss()} testID="noAccess.dismiss" />
    </Screen>
  );
}

const styles = StyleSheet.create({ text: { fontSize: fontSize.body, color: colors.foreground } });
