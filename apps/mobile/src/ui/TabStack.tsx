import { Stack } from 'expo-router';
import { stackScreenOptions } from './theme';

/** The stack inside a tab whose index screen draws its own heading. */
export function TabStack() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}
