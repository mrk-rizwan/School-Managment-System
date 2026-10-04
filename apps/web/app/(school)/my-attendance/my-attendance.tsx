'use client';

import { PageHeader } from '@/components/app-shell';
import { StaffAttendanceMonth } from '../staff-attendance/_lib/staff-attendance-month';

/** contracts/slice-12.md §4.4, R135: every staff member reads their own record, read-only. */
export function MyAttendance() {
  return (
    <>
      <PageHeader title="My attendance" description="Your attendance as the office recorded it. Ask the office about a mistake." />
      <StaffAttendanceMonth source={{ kind: 'me' }} />
    </>
  );
}
