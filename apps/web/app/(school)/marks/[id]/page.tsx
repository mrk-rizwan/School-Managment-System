import type { Metadata } from 'next';
import { MarksGridScreen } from './marks-grid';

export const metadata: Metadata = { title: 'Marks' };

export default async function MarksGridPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MarksGridScreen id={id} />;
}
