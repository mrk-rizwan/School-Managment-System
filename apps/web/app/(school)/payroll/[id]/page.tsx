import type { Metadata } from 'next';
import { RunDetail } from './run-detail';

export const metadata: Metadata = { title: 'Payroll run' };

// The id is only passed down; the run is fetched by the browser (plan §1).
export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunDetail id={id} />;
}
