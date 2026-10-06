import type { Metadata } from 'next';
import { HandoverDesk } from './handover-desk';

export const metadata: Metadata = { title: 'Cash handovers' };

export default function Page() {
  return <HandoverDesk />;
}
