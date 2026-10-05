import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { FeesTabs } from './_lib/fees-ui';

export const metadata: Metadata = { title: 'Fees' };

// One "Fees" area with a tab per resource (phase-3-financial.md slice 18). Data is fetched by the
// browser inside each tab (plan §1); this layout renders no school data.
export default function FeesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="Fees" description="What the school charges for, and how much each class pays." />
      <FeesTabs />
      {children}
    </>
  );
}
