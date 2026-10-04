import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useSession } from '../auth/session';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { colors, fontSize } from '../ui/theme';

// Offline cold start with nothing cached (slice-15 §4.1 step 4, §11).
export default function UnreachableScreen() {
  const { me, retryStartup } = useSession();
  const [busy, setBusy] = useState(false);
  const school = me?.body.school.name ?? 'the school';

  async function retry() {
    setBusy(true);
    await retryStartup();
    setBusy(false);
  }

  return (
    <Screen title="Offline" testID="unreachable.screen">
      <Text style={styles.text}>Cannot reach {school}. Check your connection.</Text>
      <Button
        label="Try again"
        busy={busy}
        onPress={() => void retry()}
        testID="unreachable.retry"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({ text: { fontSize: fontSize.body, color: colors.foreground } });
