import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { MyChildrenFees } from './my-children-fees';

export const metadata: Metadata = { title: "Children's fees" };

// A guardian's own page (phase-3-financial.md slice 21): everything is read by the browser through
// /me/* with the guardian's session; this page renders no school data on the server.
export default function Page() {
  return (
    <>
      <PageHeader title="Children's fees" description="What is owed, the deposit slips you sent, and your receipts." />
      <MyChildrenFees />
    </>
  );
}
