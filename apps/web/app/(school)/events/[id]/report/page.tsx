import type { Metadata } from 'next';
import { EventReport } from './event-report';

export const metadata: Metadata = { title: 'Event report' };

export default async function EventReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventReport id={id} />;
}
