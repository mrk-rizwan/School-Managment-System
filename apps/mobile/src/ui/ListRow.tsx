import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, space, TAP_TARGET } from './theme';

type Props = {
  title: string;
  detail?: string | null;
  /** Right-aligned short value: a count, a state. */
  value?: string | null;
  onPress?: () => void;
  destructive?: boolean;
  testID?: string;
};

export function ListRow({ title, detail, value, onPress, destructive = false, testID }: Props) {
  const content = (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={[styles.title, destructive && styles.destructive]}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {value ? <Text style={styles.value}>{value}</Text> : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TAP_TARGET,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  text: { flex: 1, gap: 2 },
  title: { fontSize: fontSize.body, color: colors.foreground },
  destructive: { color: colors.destructive },
  detail: { fontSize: fontSize.small, color: colors.mutedForeground },
  value: { fontSize: fontSize.small, color: colors.mutedForeground },
  pressed: { backgroundColor: colors.muted },
});
