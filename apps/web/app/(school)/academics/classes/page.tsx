import type { Metadata } from 'next';
import { ClassList } from './class-list';

export const metadata: Metadata = { title: 'Classes' };

// `?year=` only preselects the year select; the classes are fetched by the browser (plan §1).
export default async function ClassesPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const { year } = await searchParams;
  return <ClassList initialYearId={typeof year === 'string' ? year : undefined} />;
}
