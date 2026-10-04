import type { Metadata } from 'next';
import { AnnouncementDetail } from './announcement-detail';

export const metadata: Metadata = { title: 'Announcement' };

// The id is only passed down; the announcement is fetched by the browser (plan §1).
export default async function AnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AnnouncementDetail id={id} />;
}
