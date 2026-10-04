import { Tabs } from 'expo-router';
import { TAB_TITLES, useShellTabs } from '../../auth/shell';
import { colors, fontSize, TAP_TARGET } from '../../ui/theme';

// The role-aware shell (R156, slice-15 §5): composeTabs(me) intersected with the screens this
// build has, five slots at most. Routes in this folder that are not in the bar are hidden.

/** The tab routes that exist in this folder. */
const ROUTES = ['home', 'calendar', 'account', 'more'] as const;

export default function TabsLayout() {
  const layout = useShellTabs();
  const inBar = new Set<string>(layout.bar);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: fontSize.small },
        tabBarStyle: { minHeight: TAP_TARGET + 8, borderTopColor: colors.border },
        animation: 'none',
      }}
    >
      {ROUTES.map((route) => (
        <Tabs.Screen
          key={route}
          name={route}
          options={{
            title: TAB_TITLES[route],
            href: inBar.has(route) ? undefined : null,
            tabBarButtonTestID: `tabs.${route}`,
          }}
        />
      ))}
    </Tabs>
  );
}
