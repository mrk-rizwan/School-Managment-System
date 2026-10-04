import { StyleSheet, View } from 'react-native';
import { Button } from './Button';
import { space } from './theme';

/** Previous / Next for a page/limit list (cursor-free paging, slice-15 §9); nothing on one page. */
export function Paging({
  page,
  limit,
  total,
  onPage,
  testID,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
  testID: string;
}) {
  if (total <= limit) return null;
  return (
    <View style={styles.row}>
      {page > 1 ? (
        <Button
          label="Previous"
          variant="secondary"
          onPress={() => onPage(page - 1)}
          testID={`${testID}.previous`}
        />
      ) : null}
      {page * limit < total ? (
        <Button
          label={`Next ${limit}`}
          variant="secondary"
          onPress={() => onPage(page + 1)}
          testID={`${testID}.next`}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingTop: space.xs },
});
