import type { Metadata } from 'next';
import { EventEdit } from './event-edit';

export const metadata: Metadata = { title: 'Edit event' };

export default async function EditEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventEdit id={id} />;
}
