import type { Metadata } from 'next';
import { PunchesDay } from './punches-day';

export const metadata: Metadata = { title: 'Device punches' };

export default function PunchesPage() {
  return <PunchesDay />;
}
