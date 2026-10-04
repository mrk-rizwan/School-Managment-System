import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { sensitiveTextError } from '../outbox/bodies';
import { Button } from './Button';
import { Field } from './Field';
import { ModalSheet } from './ModalSheet';
import { colors, fontSize } from './theme';

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** The reason field's error, or null when it may be sent (3–500, no identity or phone pattern). */
export function reasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REASON_MIN) return `Give a reason of at least ${REASON_MIN} characters.`;
  if (length > REASON_MAX) return `At most ${REASON_MAX} characters.`;
  return sensitiveTextError(reason);
}

/**
 * The reason for an amendment (slice-16 §4.2, §4.3): the changed rows listed ("Ali: present →
 * absent"), the reason required before anything is saved.
 */
type Props = {
  visible: boolean;
  title?: string;
  changes: readonly string[];
  initialReason?: string;
  confirmLabel?: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  busy?: boolean;
  /** When the confirm action is not possible now (offline): shown instead of acting. */
  disabledReason?: string | null;
};

/** Mounted only while open, so every opening starts from the initial reason. */
export function ReasonSheet(props: Props) {
  return props.visible ? <OpenReasonSheet {...props} /> : null;
}

function OpenReasonSheet({
  title = 'Reason for the change',
  changes,
  initialReason = '',
  confirmLabel = 'Save with this reason',
  onConfirm,
  onClose,
  busy = false,
  disabledReason = null,
}: Props) {
  const [reason, setReason] = useState(initialReason);
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalSheet
      visible
      title={title}
      onClose={onClose}
      testID="reasonSheet"
      footer={
        <>
          {disabledReason ? <Text style={styles.changes}>{disabledReason}</Text> : null}
          <Button
            label={confirmLabel}
            busy={busy}
            disabled={disabledReason !== null}
            onPress={() => {
              const problem = reasonError(reason);
              setError(problem);
              if (problem === null) onConfirm(reason.trim());
            }}
            testID="reasonSheet.confirm"
          />
        </>
      }
    >
      {changes.map((change) => (
        <Text key={change} style={styles.changes}>
          {change}
        </Text>
      ))}
      <Field
        label="Reason"
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={REASON_MAX}
        error={error}
        testID="reasonSheet.reason"
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  changes: { fontSize: fontSize.small, color: colors.foreground },
});
