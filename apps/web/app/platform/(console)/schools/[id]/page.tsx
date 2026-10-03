import type { Metadata } from 'next';
import { SchoolDetail } from './school-detail';

export const metadata: Metadata = { title: 'School' };

// The id is only passed down; the school itself is fetched by the browser (plan §1).
export default async function SchoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SchoolDetail id={id} />;
}
