import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { queryClient } from '../api/query-client';
import { hasScreen } from '../auth/screen-registry';
import { SessionProvider, useSession } from '../auth/session';
import { configureForegroundDisplay, listenForTaps } from '../push/registration';
import { LoadingState } from '../ui/states';
import { colors } from '../ui/theme';

// Providers and the gate (slice-15 §4.1). Each full-screen state is a protected route: while the
// session is blocked by a 426 only the update screen exists, and so on.

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <StatusBar style="dark" />
          <Gate />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Gate() {
  const { status } = useSession();
  const router = useRouter();
  const signedIn = status === 'signed-in';

  useEffect(() => {
    configureForegroundDisplay();
  }, []);

  useEffect(() => {
    if (!signedIn) return undefined;
    return listenForTaps(hasScreen, (route) => router.push(route));
  }, [router, signedIn]);

  if (status === 'starting') return <LoadingState label="Starting" />;
  return (
    <Stack
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'signed-out'}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'blocked'}>
        <Stack.Screen name="update-required" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'no-access'}>
        <Stack.Screen name="no-access" />
      </Stack.Protected>
      <Stack.Protected guard={status === 'unreachable'}>
        <Stack.Screen name="unreachable" />
      </Stack.Protected>
      <Stack.Screen name="index" />
    </Stack>
  );
}
