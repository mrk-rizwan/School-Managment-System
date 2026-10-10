import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { TimetableTabs } from './_lib/timetable-ui';
import { TimetableWeek } from './timetable-week';

export const metadata: Metadata = { title: 'Timetable' };

const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

// The period timetable (contracts/slice-37.md §7). `?section=` only preselects the section; the
// week is fetched by the browser (plan §1).
export default async function TimetablePage({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const { section } = await searchParams;
  return (
    <>
      <PageHeader title="Timetable" description="A section's week: who teaches what, in which period and room." />
      <TimetableTabs />
      <TimetableWeek initialSectionId={one(section)} />
    </>
  );
}
