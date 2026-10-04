import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { logLines, logText } from '../../../platform/log';
import { Button } from '../../../ui/Button';
import { Screen } from '../../../ui/Screen';
import { EmptyState } from '../../../ui/states';
import { colors, fontSize, space } from '../../../ui/theme';

// The scrubbed log ring buffer (slice-15 §10): the last 200 lines, already free of identity
// numbers, phones and tokens. Text is selectable (long-press to copy) and can be shared.

export default function DiagnosticsScreen() {
  const [lines, setLines] = useState(logLines);
  return (
    <Screen testID="diagnostics.screen">
      <View style={styles.actions}>
        <Button
          label="Refresh"
          variant="secondary"
          onPress={() => setLines(logLines())}
          testID="diagnostics.refresh"
        />
        <Button
          label="Share"
          variant="secondary"
          onPress={() => void Share.share({ message: logText() })}
          testID="diagnostics.share"
        />
      </View>
      {lines.length === 0 ? (
        <EmptyState title="No log lines yet" />
      ) : (
        <Text selectable style={styles.log} testID="diagnostics.log">
          {lines
            .slice()
            .reverse()
            .map(
              (line) =>
                `${line.at.slice(11, 19)} ${line.level} ${line.event}${line.fields ? ` ${JSON.stringify(line.fields)}` : ''}`,
            )
            .join('\n')}
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: space.sm },
  log: { fontSize: fontSize.caption, color: colors.foreground, fontFamily: 'monospace' },
});
