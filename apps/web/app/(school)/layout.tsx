import { AppShell } from '@/components/app-shell';

// Slice 0 stand-in for GET /me's effective capabilities (slice 2 fetches them in the browser).
// A hardcoded demo list, not a security decision: the API checks every request itself.
const DEMO_CAPABILITIES = ['student.view', 'staff.view'];

export default function SchoolLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell title="ASMS" nav="school" capabilities={DEMO_CAPABILITIES}>
      {children}
    </AppShell>
  );
}
