import { Stack } from 'expo-router';
import { colors } from '../../../ui/theme';

export default function AccountLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.primary,
        headerTitleStyle: { color: colors.foreground },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="change-password" options={{ title: 'Change password' }} />
      <Stack.Screen name="sync" options={{ title: 'Sync status' }} />
      <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
    </Stack>
  );
}
