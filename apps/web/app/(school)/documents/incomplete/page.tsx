import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { IncompleteAdmissions } from './incomplete-admissions';

export const metadata: Metadata = { title: 'Incomplete admissions' };

// The incomplete-admissions report (Phase 5 slice 40, R323). Data is fetched by the browser.
export default function IncompleteAdmissionsPage() {
  return (
    <>
      <PageHeader
        title="Incomplete admissions"
        description="Students admitted in the range whose required documents are missing, awaiting a check or rejected."
      />
      <IncompleteAdmissions />
    </>
  );
}
