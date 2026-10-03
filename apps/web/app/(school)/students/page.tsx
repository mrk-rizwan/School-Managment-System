import type { Metadata } from 'next';
import { StudentList } from './student-list';

export const metadata: Metadata = { title: 'Students' };

export default function StudentsPage() {
  return <StudentList />;
}
