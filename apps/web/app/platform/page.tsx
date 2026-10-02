import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { EmptyState } from '@/components/page-states';

export const metadata: Metadata = { title: 'Schools' };

// Placeholder until slice 1 builds the school list.
export default function PlatformHomePage() {
  return (
    <>
      <PageHeader title="Schools" description="Every school on the platform." />
      <div className="rounded-lg border bg-card">
        <EmptyState title="No schools yet" description="The school list arrives in slice 1." />
      </div>
    </>
  );
}
