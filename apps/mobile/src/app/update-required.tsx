import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../auth/session';
import { readAppVersion } from '../platform/app-version';
import { applicationId } from '../platform/config';
import { log } from '../platform/log';
import { Button } from '../ui/Button';
import { Screen } from '../ui/Screen';
import { colors, fontSize, space } from '../ui/theme';

// 426 UPGRADE_REQUIRED (R161, slice-15 §11): the only screen while blocked. Nothing else renders
// and the outbox sends nothing until a request succeeds.

export default function UpdateRequiredScreen() {
  const { upgrade, checkAgain } = useSession();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function openStore() {
    const id = applicationId();
    try {
      await Linking.openURL(`market://details?id=${id}`);
    } catch {
      await Linking.openURL(`https://play.google.com/store/apps/details?id=${id}`).catch(() => {
        log('warn', 'update.store_unavailable');
      });
    }
  }

  async function check() {
    setBusy(true);
    setNote(await checkAgain());
    setBusy(false);
  }

  return (
    <Screen title="Update ASMS" testID="update.screen">
      <View style={styles.body}>
        <Text style={styles.text} testID="update.message">
          {upgrade?.message ??
            'This version of the app is no longer supported. Update the app to continue.'}
        </Text>
        {upgrade?.minimumVersion ? (
          <Text style={styles.detail} testID="update.minimumVersion">
            Required version: {upgrade.minimumVersion}
          </Text>
        ) : null}
        <Text style={styles.detail} testID="update.installedVersion">
          Installed version: {readAppVersion()}
        </Text>
        {note ? <Text style={styles.detail}>{note}</Text> : null}
        <Button label="Update" onPress={() => void openStore()} testID="update.openStore" />
        <Button
          label="Check again"
          variant="secondary"
          busy={busy}
          onPress={() => void check()}
          testID="update.checkAgain"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space.md },
  text: { fontSize: fontSize.body, color: colors.foreground },
  detail: { fontSize: fontSize.small, color: colors.mutedForeground },
});
