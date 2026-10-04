import type { Metadata } from 'next';
import { AnnouncementEdit } from './announcement-edit';

export const metadata: Metadata = { title: 'Edit announcement' };

export default async function EditAnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AnnouncementEdit id={id} />;
}
