import type { Metadata } from 'next';
import { StaffReport } from './staff-report';

export const metadata: Metadata = { title: 'Staff report' };

// Phase 5 slice 42 (contracts/slice-42.md §2.4): read by the browser with staff.view.
export default function StaffReportPage() {
  return <StaffReport />;
}
