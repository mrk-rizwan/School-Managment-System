'use client';

import { Capability } from '@asms/shared';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { useCapabilities } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { HolidayDialogs, type HolidayAction } from './holiday-dialogs';
import { HolidayList } from './holiday-list';
import { MonthView } from './month-view';

type View = 'month' | 'list';
const VIEWS: { id: View; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'list', label: 'Holidays' },
];

/** contracts/slice-10.md §13. Readable by every staff member; writes need holiday.manage. */
export function CalendarScreen() {
  const { can } = useCapabilities();
  const [view, setView] = useState<View>('month');
  const [action, setAction] = useState<HolidayAction | null>(null);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Weekly days off and holidays. Published holidays are announced to families and staff."
        actions={
          can(Capability.HOLIDAY_MANAGE) && (
            <Button onClick={() => setAction({ kind: 'create' })}>
              <PlusIcon />
              New holiday
            </Button>
          )
        }
      />
      <div role="tablist" aria-label="Calendar view" className="mb-6 flex gap-1 border-b">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={`calendar-tab-${v.id}`}
            aria-selected={view === v.id}
            aria-controls={`calendar-panel-${v.id}`}
            onClick={() => setView(v.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              view === v.id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`calendar-panel-${view}`} aria-labelledby={`calendar-tab-${view}`}>
        {view === 'month' ? <MonthView onAction={setAction} /> : <HolidayList onAction={setAction} />}
      </div>
      <HolidayDialogs action={action} onAction={setAction} />
    </>
  );
}
