import { Stack } from 'expo-router';
import { stackScreenOptions } from '../../../ui/theme';

export default function HomeLayout() {
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}
