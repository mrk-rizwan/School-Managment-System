import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { ReportsTabs } from './_lib/reports-ui';

export const metadata: Metadata = { title: 'Finance reports' };

// One "Finance reports" area with a tab per report (phase-3-financial.md slice 22). Data is
// fetched by the browser inside each tab (plan §1); this layout renders no school data.
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Finance reports" description="Who owes, what came in, what went out." />
      <ReportsTabs />
      {children}
    </>
  );
}
