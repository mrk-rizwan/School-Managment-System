import { StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { colors, fontSize, space } from './theme';

/** Previous · month title · Next — the calendar and the attendance months (slice-16 §12). */
export function MonthHeader({
  title,
  onPrevious,
  onNext,
  nextDisabled = false,
  testID,
}: {
  title: string;
  onPrevious: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
  /** The ids are `<testID>.previous`, `.month`, `.next`. */
  testID: string;
}) {
  return (
    <View style={styles.month}>
      <Button
        label="Previous"
        variant="secondary"
        onPress={onPrevious}
        testID={`${testID}.previous`}
      />
      <Text style={styles.title} testID={`${testID}.month`}>
        {title}
      </Text>
      <Button
        label="Next"
        variant="secondary"
        onPress={onNext}
        disabled={nextDisabled}
        testID={`${testID}.next`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  month: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  title: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground, flexShrink: 1 },
});
