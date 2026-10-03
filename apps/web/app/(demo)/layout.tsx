import { AppShell } from '@/components/app-shell';

// THROWAWAY (slice 0.7): the component demo, moved out of (school) in slice 2 because the school
// layout now requires a signed-in session. Delete this route group, its nav entry and the smoke
// test that opens it together. The capability list is a hardcoded demo, not a security decision.
const DEMO_CAPABILITIES = ['student.view', 'staff.view'];

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell title="ASMS" nav="school" capabilities={DEMO_CAPABILITIES}>
      {children}
    </AppShell>
  );
}
