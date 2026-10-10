import type { Metadata } from 'next';
import { TimetableEditor } from './timetable-editor';

export const metadata: Metadata = { title: 'Edit timetable' };

// The week-grid editor (contracts/slice-37.md §7). The id is only passed down; the section's
// timetable is fetched by the browser (plan §1).
export default async function EditTimetablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TimetableEditor sectionId={id} />;
}
