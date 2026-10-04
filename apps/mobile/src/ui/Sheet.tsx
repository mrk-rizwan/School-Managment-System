import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, space } from './theme';

/** A titled group of rows on a card: account actions, a lane in the sync sheet. */
export function Sheet({
  title,
  children,
  testID,
}: {
  title?: string;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.sheet} testID={testID}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius,
    backgroundColor: colors.card,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  title: {
    fontSize: fontSize.caption,
    fontWeight: '600',
    color: colors.mutedForeground,
    textTransform: 'uppercase',
    paddingTop: space.sm,
  },
});
