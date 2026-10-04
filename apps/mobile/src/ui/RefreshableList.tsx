import type { ReactElement } from 'react';
import { FlatList, RefreshControl, StyleSheet, type ListRenderItem } from 'react-native';
import { Button } from './Button';
import { colors, space } from './theme';

/**
 * A list with pull-to-refresh — the one manual refresh, disabled offline (slice-16 §3.1) — and an
 * optional "more" footer for paging. 20 rows render first; fixed-height rows pass `rowHeight`.
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
  moreLabel,
  onMore,
  rowHeight,
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
  /** The paging footer's label ("Earlier", "Next 25"); shown when onMore is given. */
  moreLabel?: string;
  onMore?: () => void;
  rowHeight?: number;
  testID?: string;
}) {
  return (
    <FlatList
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      initialNumToRender={20}
      getItemLayout={
        rowHeight === undefined
          ? undefined
          : (_, index) => ({ length: rowHeight, offset: rowHeight * index, index })
      }
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
      ListFooterComponent={
        onMore ? (
          <Button
            label={moreLabel ?? 'More'}
            variant="secondary"
            onPress={onMore}
            testID={testID ? `${testID}.more` : undefined}
          />
        ) : null
      }
      contentContainerStyle={styles.content}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  content: { gap: space.sm, paddingBottom: space.lg },
});
