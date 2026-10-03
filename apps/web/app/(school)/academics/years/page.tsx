import type { Metadata } from 'next';
import { AcademicYears } from './academic-years';

export const metadata: Metadata = { title: 'Academic years' };

export default function AcademicYearsPage() {
  return <AcademicYears />;
}
