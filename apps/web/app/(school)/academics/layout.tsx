import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { AcademicsTabs } from './_lib/academics-ui';

export const metadata: Metadata = { title: 'Academic structure' };

// One "Academic structure" area with a tab per resource (contracts/slice-3.md §8). Data is
// fetched by the browser inside each tab (plan §1); this layout renders no school data.
export default function AcademicsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader
        title="Academic structure"
        description="Sessions, classes, sections and subjects."
      />
      <AcademicsTabs />
      {children}
    </>
  );
}
