import type { Metadata } from 'next';
import { SectionDiary } from './section-diary';

export const metadata: Metadata = { title: 'Section diary' };

// The id is only passed down; the diary is fetched by the browser (plan §1).
export default async function SectionDiaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SectionDiary sectionId={id} />;
}
