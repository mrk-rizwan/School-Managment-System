import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../auth/session';
import { readRemembered } from '../auth/session-store';
import { maskIdentity } from '../auth/sign-in';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Screen } from '../ui/Screen';
import { colors, fontSize, space } from '../ui/theme';

// Sign-in (slice-15 §4.2). The school code is remembered; the identity number is remembered only
// in the secure store and shown masked, never in full after the first login; the password is
// never remembered.

export default function SignInScreen() {
  const session = useSession();
  const [schoolCode, setSchoolCode] = useState('');
  const [rememberedUsername, setRememberedUsername] = useState<string | null>(null);
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read again whenever the session returns here (a 401 after a remembered sign-in).
  const signedOut = session.status === 'signed-out';
  useEffect(() => {
    if (!signedOut) return;
    void readRemembered().then((remembered) => {
      setSchoolCode(remembered.schoolCode ?? '');
      setRememberedUsername(remembered.username);
    });
  }, [signedOut]);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await session.signIn({
      schoolCode,
      identity: rememberedUsername ?? identity,
      password,
    });
    setBusy(false);
    if (result.ok) return;
    setPassword('');
    setError(result.message);
  }

  async function notMySchool() {
    await session.notMySchool();
    setSchoolCode('');
  }

  function forgetMe() {
    Alert.alert('Forget this number?', 'Anything on this phone from your account is removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget me',
        style: 'destructive',
        onPress: () => {
          void session.forgetMe().then(() => {
            setRememberedUsername(null);
            setIdentity('');
          });
        },
      },
    ]);
  }

  function discardUnsent() {
    Alert.alert('Discard unsent items?', 'They have not reached the school and will be lost.', [
      { text: 'Keep them', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => void session.discardUnsent() },
    ]);
  }

  const canSubmit =
    schoolCode.trim() !== '' &&
    password !== '' &&
    (rememberedUsername !== null || identity.trim() !== '');

  return (
    <Screen
      title="Sign in"
      testID="signIn.screen"
      banner={
        session.discardedNotice !== null ? (
          <Banner
            testID="signIn.discarded"
            tone="warning"
            text={session.discardedNotice}
            onDismiss={session.dismissDiscardedNotice}
          />
        ) : session.sessionEnded || session.unsent > 0 ? (
          <Banner
            testID="signIn.notice"
            tone="warning"
            text={[
              session.sessionEnded ? 'Your session ended. Sign in again.' : null,
              session.unsent > 0
                ? `${session.unsent} unsent ${session.unsent === 1 ? 'item' : 'items'} will be sent after you sign in.`
                : null,
            ]
              .filter(Boolean)
              .join(' ')}
            actionLabel={session.unsent > 0 ? 'Discard them' : undefined}
            onAction={session.unsent > 0 ? discardUnsent : undefined}
          />
        ) : null
      }
    >
      <View style={styles.form}>
        <Field
          label="School code"
          value={schoolCode}
          onChangeText={setSchoolCode}
          autoCapitalize="none"
          testID="signIn.schoolCode"
        />
        {schoolCode !== '' ? (
          <Button
            label="Not your school?"
            variant="link"
            onPress={() => void notMySchool()}
            testID="signIn.notMySchool"
          />
        ) : null}
        {rememberedUsername !== null ? (
          <View style={styles.remembered}>
            <Text style={styles.label}>CNIC or B-Form number</Text>
            <Text style={styles.masked} testID="signIn.maskedIdentity">
              {maskIdentity(rememberedUsername)}
            </Text>
            <Button
              label="Not you? Forget me"
              variant="link"
              onPress={forgetMe}
              testID="signIn.forgetMe"
            />
          </View>
        ) : (
          <Field
            label="CNIC or B-Form number"
            value={identity}
            onChangeText={setIdentity}
            keyboardType="number-pad"
            placeholder="35201-1234567-1"
            autoComplete="off"
            importantForAutofill="no"
            testID="signIn.identity"
          />
        )}
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="password"
          testID="signIn.password"
        />
        {error ? (
          <Text style={styles.error} accessibilityRole="alert" testID="signIn.error">
            {error}
          </Text>
        ) : null}
        <Button
          label="Sign in"
          onPress={() => void submit()}
          disabled={!canSubmit}
          busy={busy}
          testID="signIn.submit"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.md },
  remembered: { gap: space.xs },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  masked: { fontSize: fontSize.body, color: colors.foreground, letterSpacing: 1 },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
