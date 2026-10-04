import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, space, TAP_TARGET } from './theme';

// One choice from a short list (status in the amend sheet, visibility, category, subject):
// 48-dp options that wrap at 360 dp; the chosen one is filled.

export type PickerOption<T extends string> = { value: T; label: string };

export function SegmentedPicker<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  testID,
}: {
  label: string;
  options: readonly PickerOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Shown but not changeable (a saved draft, offline). */
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {options.map((option) => {
          const chosen = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: chosen, disabled }}
              disabled={disabled}
              onPress={() => onChange(option.value)}
              style={[styles.option, chosen && styles.chosen, disabled && styles.disabled]}
              testID={testID ? `${testID}.${option.value}` : undefined}
            >
              <Text style={[styles.text, chosen && styles.chosenText]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  option: {
    minHeight: TAP_TARGET,
    paddingHorizontal: space.md,
    justifyContent: 'center',
    borderRadius: radius,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  chosen: { backgroundColor: colors.primary, borderColor: colors.primary },
  text: { fontSize: fontSize.small, color: colors.foreground },
  chosenText: { color: colors.primaryForeground, fontWeight: '600' },
  disabled: { opacity: 0.5 },
});
