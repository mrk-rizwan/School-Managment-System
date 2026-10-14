import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PageHeader } from '@/components/app-shell';
import { AuditLog } from './audit-log';

export const metadata: Metadata = { title: 'Audit log' };

// The audit log (Phase 5 slice 46, rule 40). Data is fetched by the browser (plan §1); the filters
// may arrive in the address (a support-session notice links here filtered by the session).
export default function AuditPage() {
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who changed what, and when. Account and role changes are not listed here; identity numbers, phone numbers and email addresses are masked."
      />
      <Suspense>
        <AuditLog />
      </Suspense>
    </>
  );
}
