import { AppShell } from '@/components/app-shell';

// The platform console: its own layout, its own session (plan §1). It shares the shell
// component with the school console but none of its navigation.
// When /platform/login is added it must sit outside this shell, e.g. by moving the console
// pages into app/platform/(console)/.
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell title="ASMS Platform" nav="platform">
      {children}
    </AppShell>
  );
}
