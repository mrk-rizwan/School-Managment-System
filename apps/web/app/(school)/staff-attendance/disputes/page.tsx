import type { Metadata } from 'next';
import { DisputesQueue } from './disputes-queue';

export const metadata: Metadata = { title: 'Attendance disputes' };

export default function DisputesPage() {
  return <DisputesQueue />;
}
