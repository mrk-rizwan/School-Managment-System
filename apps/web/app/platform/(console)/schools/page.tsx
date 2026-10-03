import type { Metadata } from 'next';
import { SchoolList } from './school-list';

export const metadata: Metadata = { title: 'Schools' };

export default function SchoolsPage() {
  return <SchoolList />;
}
