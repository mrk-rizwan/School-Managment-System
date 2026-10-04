import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, space, TAP_TARGET } from './theme';

/**
 * A bottom sheet over the screen: a title, scrolling content, and a close control. The row
 * sheet, the reason sheet, the date sheet and the entry sheet are built on it.
 */
export function ModalSheet({
  visible,
  title,
  onClose,
  children,
  footer,
  testID,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Actions pinned below the content (thumb reach). */
  footer?: ReactNode;
  testID?: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID={testID}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={styles.close}
              testID={testID ? `${testID}.close` : undefined}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: colors.background,
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
  },
  title: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground, flexShrink: 1 },
  close: { minHeight: TAP_TARGET, justifyContent: 'center', paddingHorizontal: space.sm },
  closeText: { fontSize: fontSize.small, color: colors.primary, fontWeight: '600' },
  content: { padding: space.lg, gap: space.md },
  footer: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.sm,
  },
});
