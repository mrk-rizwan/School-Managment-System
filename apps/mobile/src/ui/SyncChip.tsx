import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useOutbox } from '../outbox/runtime';
import { colors, fontSize, radius, space, TAP_TARGET } from './theme';

/** The header chip shown while anything is not on the server; opens the sync sheet (slice-15 §7.7). */
export function SyncChip() {
  const router = useRouter();
  const { items } = useOutbox();
  if (items.length === 0) return null;
  const failed = items.filter((item) => item.state === 'failed').length;
  const label = failed > 0 ? `${failed} not saved` : `${items.length} on device`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Sync status: ${label}`}
      onPress={() => router.push('/account/sync')}
      style={[styles.chip, failed > 0 && styles.failed]}
      testID="sync.chip"
    >
      <Text style={[styles.text, failed > 0 && styles.failedText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius,
    backgroundColor: colors.muted,
  },
  failed: { borderWidth: 1, borderColor: colors.destructive },
  text: { fontSize: fontSize.small, color: colors.foreground },
  failedText: { color: colors.destructive },
});
