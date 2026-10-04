import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, space, TAP_TARGET } from './theme';

type Props = {
  text: string;
  tone?: 'info' | 'warning';
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  testID?: string;
};

/** A one-line notice above the content: the default-password prompt, a lost session, offline. */
export function Banner({ text, tone = 'info', actionLabel, onAction, onDismiss, testID }: Props) {
  return (
    <View
      style={[styles.banner, tone === 'warning' && styles.warning]}
      testID={testID}
      accessibilityRole="alert"
    >
      <Text style={styles.text}>{text}</Text>
      <View style={styles.actions}>
        {actionLabel && onAction ? (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            style={styles.action}
            testID={testID ? `${testID}.action` : undefined}
          >
            <Text style={styles.actionText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
        {onDismiss ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            onPress={onDismiss}
            style={styles.action}
            testID={testID ? `${testID}.dismiss` : undefined}
          >
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: space.lg,
    padding: space.md,
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.muted,
    gap: space.xs,
  },
  warning: { borderColor: colors.ring },
  text: { fontSize: fontSize.small, color: colors.foreground },
  actions: { flexDirection: 'row', gap: space.sm },
  action: { minHeight: TAP_TARGET, justifyContent: 'center' },
  actionText: { fontSize: fontSize.small, fontWeight: '600', color: colors.primary },
  dismissText: { fontSize: fontSize.small, color: colors.mutedForeground },
});
