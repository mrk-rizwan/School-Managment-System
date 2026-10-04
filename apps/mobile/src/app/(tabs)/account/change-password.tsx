import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../../auth/session';
import { useOnline } from '../../../net/connectivity';
import { Button } from '../../../ui/Button';
import { Field } from '../../../ui/Field';
import { Screen } from '../../../ui/Screen';
import { colors, fontSize, space } from '../../../ui/theme';

// POST /me/change-password (slice-15 §4.4). Online only; needs a verified email (rule 12: every
// changed password has a reset path). The new token replaces the stored one first.

export default function ChangePasswordScreen() {
  const router = useRouter();
  const { changePassword } = useSession();
  const online = useOnline();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (next.length < 8) return setErrors({ next: 'Use at least 8 characters.' });
    if (next !== confirm) return setErrors({ next: 'The two new passwords do not match.' });
    setBusy(true);
    setErrors({});
    const result = await changePassword(current, next);
    setBusy(false);
    if (result.ok) {
      router.back();
      return;
    }
    if (result.field === 'currentPassword') setErrors({ current: result.message });
    else if (result.field === 'newPassword') setErrors({ next: result.message });
    else setErrors({ form: result.message });
  }

  return (
    <Screen testID="changePassword.screen">
      <View style={styles.form}>
        {!online ? (
          <Text style={styles.offline}>Changing the password needs a connection.</Text>
        ) : null}
        <Field
          label="Current password"
          value={current}
          onChangeText={setCurrent}
          secureTextEntry
          error={errors.current}
          testID="changePassword.current"
        />
        <Field
          label="New password"
          value={next}
          onChangeText={setNext}
          secureTextEntry
          error={errors.next}
          hint="At least 8 characters."
          testID="changePassword.new"
        />
        <Field
          label="New password again"
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          testID="changePassword.confirm"
        />
        {errors.form ? (
          <Text style={styles.error} accessibilityRole="alert" testID="changePassword.error">
            {errors.form}
          </Text>
        ) : null}
        <Button
          label="Change password"
          onPress={() => void submit()}
          disabled={!online || current === '' || next === ''}
          busy={busy}
          testID="changePassword.submit"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.md },
  offline: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
