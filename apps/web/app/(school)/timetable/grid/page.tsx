import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { TimetableTabs } from '../_lib/timetable-ui';
import { TimetableGrid } from './timetable-grid';

export const metadata: Metadata = { title: 'Timetable grid' };

// contracts/slice-37.md §2.8, §7: the principal's grid, every section of the year by period for
// one weekday.
export default function TimetableGridPage() {
  return (
    <>
      <PageHeader title="Timetable grid" description="Every section's lessons for one day, side by side." />
      <TimetableTabs />
      <TimetableGrid />
    </>
  );
}
