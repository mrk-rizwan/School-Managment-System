import type { Metadata } from 'next';
import { StudentProfile } from './student-profile';

export const metadata: Metadata = { title: 'Student profile' };

// Phase 5 slice 42 (contracts/slice-42.md §2.3): the one-page profile, fetched by the browser
// with student.view in the caller's scope and printed from the page.
export default async function StudentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentProfile id={id} />;
}
