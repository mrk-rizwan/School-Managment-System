import type { Metadata } from 'next';
import { AnnouncementCompose } from '../announcement-compose';

export const metadata: Metadata = { title: 'New announcement' };

export default function NewAnnouncementPage() {
  return <AnnouncementCompose />;
}
