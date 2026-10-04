import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors, fontSize, radius, space, TAP_TARGET } from './theme';

type Props = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive' | 'link';
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  testID,
}: Props) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        inactive && styles.inactive,
        pressed && !inactive && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator
          color={variant === 'primary' ? colors.primaryForeground : colors.primary}
        />
      ) : (
        <Text style={[styles.label, labelStyles[variant]]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: TAP_TARGET,
    borderRadius: radius,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  destructive: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.destructive,
  },
  link: { backgroundColor: 'transparent', paddingHorizontal: space.sm },
  inactive: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  label: { fontSize: fontSize.body, fontWeight: '600' },
});

const labelStyles = StyleSheet.create({
  primary: { color: colors.primaryForeground },
  secondary: { color: colors.foreground },
  destructive: { color: colors.destructive },
  link: { color: colors.primary },
});
