import type { Metadata } from 'next';
import { EventDetail } from './event-detail';

export const metadata: Metadata = { title: 'Event' };

// The id is only passed down; the event is fetched by the browser (plan §1).
export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventDetail id={id} />;
}
