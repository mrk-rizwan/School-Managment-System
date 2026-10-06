import type { Metadata } from 'next';
import { CollectionsReport } from './collections-report';

export const metadata: Metadata = { title: 'Collections' };

export default function Page() {
  return <CollectionsReport />;
}
