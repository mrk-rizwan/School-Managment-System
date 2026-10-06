import type { Metadata } from 'next';
import { ConcessionQueue } from './concession-queue';

export const metadata: Metadata = { title: 'Concessions' };

export default function ConcessionsPage() {
  return <ConcessionQueue />;
}
