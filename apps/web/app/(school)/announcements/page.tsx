import type { Metadata } from 'next';
import { AnnouncementList } from './announcement-list';

export const metadata: Metadata = { title: 'Announcements' };

export default function AnnouncementsPage() {
  return <AnnouncementList />;
}
