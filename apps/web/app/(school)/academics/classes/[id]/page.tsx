import type { Metadata } from 'next';
import { ClassDetail } from './class-detail';

export const metadata: Metadata = { title: 'Class' };

// The id is only passed down; the class is fetched by the browser (plan §1).
export default async function ClassPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ClassDetail id={id} />;
}
