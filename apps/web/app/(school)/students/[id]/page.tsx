import type { Metadata } from 'next';
import { StudentDetail } from './student-detail';

export const metadata: Metadata = { title: 'Student' };

// The id is only passed down; the student is fetched by the browser (plan §1).
export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentDetail id={id} />;
}
