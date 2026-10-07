import type { Metadata } from 'next';
import { MarksHome } from './marks-home';

export const metadata: Metadata = { title: 'Marks' };

export default function MarksPage() {
  return <MarksHome />;
}
