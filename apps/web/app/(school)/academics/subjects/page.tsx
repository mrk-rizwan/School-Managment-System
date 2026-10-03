import type { Metadata } from 'next';
import { SubjectList } from './subject-list';

export const metadata: Metadata = { title: 'Subjects' };

export default function SubjectsPage() {
  return <SubjectList />;
}
