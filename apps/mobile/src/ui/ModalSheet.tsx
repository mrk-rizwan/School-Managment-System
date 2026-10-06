import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, radius, space, TAP_TARGET } from './theme';

/*
 * Sheets are drawn inside the screen's own view tree, never in a React Native <Modal>: a Modal is
 * a separate Android window, which the Activity's FLAG_SECURE (Screen `secure`) does not cover, so
 * a deposit slip or a receipt in a Modal could be screenshotted (slice-27 review). The Screen is
 * the host: a sheet registers its element there and the host draws it over the whole screen.
 */

type Host = { show: (id: string, sheet: ReactNode) => void; hide: (id: string) => void };

const SheetHostContext = createContext<Host | null>(null);

/** Rendered by Screen around its content: the layer the screen's open sheets are drawn on. */
export function SheetHost({ children }: { children: ReactNode }) {
  const [sheets, setSheets] = useState<(readonly [string, ReactNode])[]>([]);
  const host = useMemo<Host>(
    () => ({
      show: (id, sheet) =>
        setSheets((list) =>
          list.some(([key]) => key === id)
            ? list.map((entry) => (entry[0] === id ? ([id, sheet] as const) : entry))
            : [...list, [id, sheet] as const],
        ),
      hide: (id) => setSheets((list) => (list.some(([key]) => key === id) ? list.filter(([key]) => key !== id) : list)),
    }),
    [],
  );
  return (
    <SheetHostContext.Provider value={host}>
      <View style={styles.fill}>{children}</View>
      {sheets.map(([id, sheet]) => (
        <View key={id} style={StyleSheet.absoluteFill}>
          {sheet}
        </View>
      ))}
    </SheetHostContext.Provider>
  );
}

/**
 * A bottom sheet over the screen: a title, scrolling content, and a close control. The row
 * sheet, the reason sheet, the date sheet and the entry sheet are built on it. The hardware back
 * button closes the top sheet.
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
  const host = useContext(SheetHostContext);
  const id = useId();
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  // On open, TalkBack moves to the sheet's title, as it does into a Modal window.
  const focusTitle = useCallback((node: Text | null) => {
    if (node !== null) AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  }, []);

  const sheet = visible ? (
    <View style={styles.backdrop} accessibilityViewIsModal>
      <View style={styles.sheet} testID={testID}>
        <View style={styles.header}>
          <Text ref={focusTitle} accessibilityRole="header" style={styles.title}>
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
  ) : null;

  // Every render: the host draws the current element (its handlers and state are this render's).
  useLayoutEffect(() => {
    if (host === null) return;
    if (sheet === null) host.hide(id);
    else host.show(id, sheet);
  });
  useLayoutEffect(() => (host === null ? undefined : () => host.hide(id)), [host, id]);

  // The hardware back button closes the top sheet (the last listener added runs first).
  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onCloseRef.current();
      return true;
    });
    return () => subscription.remove();
  }, [visible]);

  if (host !== null || sheet === null) return null;
  // Outside a Screen (a component under test on its own): drawn in place.
  return <View style={StyleSheet.absoluteFill}>{sheet}</View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
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
