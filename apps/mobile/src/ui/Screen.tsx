import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, fontSize, space } from './theme';

type Props = {
  title?: string;
  /** Right of the title: the sync chip, say. */
  accessory?: ReactNode;
  /** Above the content, full width: the offline notice or a banner. */
  banner?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  testID?: string;
};

export function Screen({ title, accessory, banner, children, scroll = true, testID }: Props) {
  const body = <View style={styles.content}>{children}</View>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']} testID={testID}>
      {title !== undefined || accessory !== undefined ? (
        <View style={styles.header}>
          {title !== undefined ? (
            <Text accessibilityRole="header" style={styles.title}>
              {title}
            </Text>
          ) : (
            <View />
          )}
          {accessory}
        </View>
      ) : null}
      {banner}
      {scroll ? <ScrollView contentContainerStyle={styles.scroll}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  title: { fontSize: fontSize.heading, fontWeight: '700', color: colors.foreground, flexShrink: 1 },
  scroll: { flexGrow: 1 },
  content: { flexGrow: 1, padding: space.lg, gap: space.lg },
});
