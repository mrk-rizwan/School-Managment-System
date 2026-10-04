'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, StateCard } from '@/components/page-states';
import { buttonVariants } from '@/components/ui/button';
import { todayInSchool } from '@/lib/format';
import { useSchoolMe } from '@/lib/school-session';
import { mySections } from '../attendance/_lib/attendance-ui';
import { NO_PLACEMENT, PlacementSelects, type Placement } from '../students/_lib/placement';
import { diaryHref } from './_lib/diary-ui';

// contracts/slice-13.md §11: the diary is kept per section. A teacher's own sections come first
// (GET /me assignments); a school-wide diary.write holder picks any class and section.

export function DiaryHome() {
  const router = useRouter();
  const me = useSchoolMe();
  const mine = mySections(me.data, todayInSchool());
  const [placement, setPlacement] = useState<Placement>(NO_PLACEMENT);

  return (
    <>
      <PageHeader title="Diary" description="Homework and class work, written per section and subject." />
      <div className="grid gap-6">
        {mine.length > 0 ? (
          <section aria-label="Your sections" className="grid gap-2">
            <h2 className="text-sm font-medium">Your sections</h2>
            <ul className="flex flex-wrap gap-2">
              {mine.map((s) => (
                <li key={s.sectionId}>
                  <Link href={diaryHref(s.sectionId)} className={buttonVariants({ variant: 'outline' })}>
                    {s.className} {s.sectionName}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <StateCard>
            <EmptyState
              title="You are not assigned to a section today"
              description="Choose a class and section below to open its diary."
            />
          </StateCard>
        )}
        <section aria-label="Another section" className="grid gap-2">
          <h2 className="text-sm font-medium">Another section</h2>
          <div className="flex flex-wrap items-end gap-3">
            <PlacementSelects
              value={placement}
              compact
              onChange={(next) => {
                setPlacement(next);
                if (next.sectionId) router.push(diaryHref(next.sectionId));
              }}
            />
          </div>
        </section>
      </div>
    </>
  );
}
