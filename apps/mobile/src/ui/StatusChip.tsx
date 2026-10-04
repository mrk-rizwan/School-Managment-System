import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, statusColors, statusTone, TAP_TARGET, type ChipStatus } from './theme';

// A 48 × 48 status chip (slice-16 §3.3): colour and letter together, never colour alone; the
// accessibility label carries the word.

type Props = {
  status: ChipStatus | null;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  testID?: string;
};

export function StatusChip({ status, onPress, onLongPress, disabled = false, testID }: Props) {
  const tone = statusTone(status);
  const chip = (
    <View
      style={[
        styles.chip,
        { backgroundColor: tone.background },
        tone.border === 'dashed' && styles.dashed,
        tone.border === 'hollow' && styles.hollow,
      ]}
    >
      <Text style={[styles.letter, { color: tone.foreground }]}>{tone.letter}</Text>
    </View>
  );
  if (!onPress && !onLongPress) {
    return (
      <View accessibilityLabel={tone.word} testID={testID}>
        {chip}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tone.word}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
    >
      {chip}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    width: TAP_TARGET,
    height: TAP_TARGET,
    borderRadius: radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dashed: { borderWidth: 2, borderStyle: 'dashed', borderColor: statusColors.onStatus },
  hollow: { borderWidth: 1, borderColor: statusColors.unrecordedText },
  letter: { fontSize: 18, fontWeight: '700' },
});
