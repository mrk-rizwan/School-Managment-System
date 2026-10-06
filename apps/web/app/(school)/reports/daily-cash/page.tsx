import type { Metadata } from 'next';
import { DailyCashReport } from './daily-cash-report';

export const metadata: Metadata = { title: 'Daily cash' };

export default function Page() {
  return <DailyCashReport />;
}
