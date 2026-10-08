import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { MyChildrenResultsList } from './my-children-results';

export const metadata: Metadata = { title: "Children's results" };

// A guardian's children (contracts/slice-33.md §5): pick a child to see their results.
export default function Page() {
  return (
    <>
      <PageHeader title="Children's results" description="Published term results, report cards and class tests." />
      <MyChildrenResultsList />
    </>
  );
}
