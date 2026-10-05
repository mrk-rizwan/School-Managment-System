import type { ReactElement } from 'react';
import { FlatList, RefreshControl, StyleSheet, type ListRenderItem } from 'react-native';
import { colors, space } from './theme';

/**
 * A list with pull-to-refresh — the one manual refresh, disabled offline (slice-16 §3.1). 20 rows
 * render first.
 */
export function RefreshableList<T>({
  data,
  renderItem,
  keyExtractor,
  online,
  refreshing,
  onRefresh,
  header,
  empty,
  testID,
}: {
  data: readonly T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T) => string;
  online: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  header?: ReactElement | null;
  empty?: ReactElement | null;
  testID?: string;
}) {
  return (
    <FlatList
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      initialNumToRender={20}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={online ? onRefresh : undefined}
          enabled={online}
          colors={[colors.primary]}
        />
      }
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      contentContainerStyle={styles.content}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  content: { gap: space.sm, paddingBottom: space.lg },
});
