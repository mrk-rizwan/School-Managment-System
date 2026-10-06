import type { Metadata } from 'next';
import { OutstandingReport } from './outstanding-report';

export const metadata: Metadata = { title: 'Outstanding dues' };

export default function Page() {
  return <OutstandingReport />;
}
