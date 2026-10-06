import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useEffect, useId, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOnline } from '../net/connectivity';
import { SheetHost } from './ModalSheet';
import { colors, fontSize, space } from './theme';

type Props = {
  title?: string;
  /** Right of the title: the sync chip, say. */
  accessory?: ReactNode;
  /** Above the content, full width: the offline notice or a banner. */
  banner?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  /** Pull-to-refresh for a scrolling screen, disabled offline (slice-16 §3.1). */
  onRefresh?: () => void;
  /** The refresh spinner, for a caller that tracks its own refresh. */
  refreshing?: boolean;
  /**
   * A screen that shows a child's name (slice-16 §13.2): Android FLAG_SECURE while it is
   * mounted — no screenshot, no recent-apps thumbnail, no screen recording of the window.
   */
  secure?: boolean;
  /** Below the content, outside the scroll: the primary action, in thumb reach. */
  footer?: ReactNode;
  testID?: string;
};

/** The only importer of expo-screen-capture (lint): FLAG_SECURE while `secure` is mounted. */
function useSecureWindow(secure: boolean): void {
  const key = useId();
  useEffect(() => {
    if (!secure) return undefined;
    void preventScreenCaptureAsync(key);
    return () => {
      void allowScreenCaptureAsync(key);
    };
  }, [secure, key]);
}

export function Screen({
  title,
  accessory,
  banner,
  children,
  scroll = true,
  onRefresh,
  refreshing = false,
  secure = false,
  footer,
  testID,
}: Props) {
  useSecureWindow(secure);
  const online = useOnline();
  const body = <View style={[styles.content, !scroll && styles.fill]}>{children}</View>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']} testID={testID}>
      <SheetHost>
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
        {scroll ? (
          <ScrollView
            contentContainerStyle={styles.scroll}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  refreshing={refreshing}
                  enabled={online}
                  onRefresh={onRefresh}
                  colors={[colors.primary]}
                />
              ) : undefined
            }
          >
            {body}
          </ScrollView>
        ) : (
          body
        )}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </SheetHost>
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
  fill: { flex: 1 },
  footer: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});
