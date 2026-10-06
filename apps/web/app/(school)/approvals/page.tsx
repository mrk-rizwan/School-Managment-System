import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { ApprovalsBoard } from './approvals-board';

export const metadata: Metadata = { title: 'Approvals' };

// Approvals (phase-3-financial.md slice 27, R227): the decision queues the user may act on, and
// the principal's dashboard tiles. Data is fetched by the browser (plan §1).
export default function ApprovalsPage() {
  return (
    <>
      <PageHeader title="Approvals" description="What is waiting for your decision. Open a queue to decide." />
      <ApprovalsBoard />
    </>
  );
}
