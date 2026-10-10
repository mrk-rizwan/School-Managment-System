import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { TimetableTabs } from '../_lib/timetable-ui';
import { SubstitutionList } from './substitution-list';

export const metadata: Metadata = { title: 'Substitutions' };

// contracts/slice-37.md §2.4, §7: one-off substitutions (a teacher for one date and period).
export default function SubstitutionsPage() {
  return (
    <>
      <PageHeader
        title="Substitutions"
        description="A substitute teaches one timetabled period on one date in place of the regular teacher."
      />
      <TimetableTabs />
      <SubstitutionList />
    </>
  );
}
