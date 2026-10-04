import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, fontSize, radius, space, TAP_TARGET } from './theme';

type Props = Omit<TextInputProps, 'style'> & {
  label: string;
  error?: string | null;
  hint?: string | null;
  testID?: string;
};

export function Field({ label, error, hint, testID, ...input }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.mutedForeground}
        autoCorrect={false}
        testID={testID}
        style={[styles.input, error ? styles.inputError : null]}
        {...input}
      />
      {error ? (
        <Text style={styles.error} testID={testID ? `${testID}.error` : undefined}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  input: {
    minHeight: TAP_TARGET,
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius,
    paddingHorizontal: space.md,
    fontSize: fontSize.body,
    color: colors.foreground,
    backgroundColor: colors.background,
  },
  inputError: { borderColor: colors.destructive },
  error: { fontSize: fontSize.small, color: colors.destructive },
  hint: { fontSize: fontSize.small, color: colors.mutedForeground },
});
