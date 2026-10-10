import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { TimetableTabs } from '../_lib/timetable-ui';
import { VersionList } from './version-list';

export const metadata: Metadata = { title: 'Timetable versions' };

// contracts/slice-37.md §2.1, §2.3, §7: every version of every section; a version that has not
// started yet may be voided. Data is fetched by the browser (plan §1).
export default function TimetableVersionsPage() {
  return (
    <>
      <PageHeader
        title="Timetable versions"
        description="Each saved timetable applies from its start date until the next one starts. One that has not started yet can be voided."
      />
      <TimetableTabs />
      <VersionList />
    </>
  );
}
