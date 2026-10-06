import type { Metadata } from 'next';
import { ConcessionsReport } from './concessions-report';

export const metadata: Metadata = { title: 'Concessions' };

export default function Page() {
  return <ConcessionsReport />;
}
