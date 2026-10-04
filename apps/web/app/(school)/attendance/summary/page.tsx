import type { Metadata } from 'next';
import { SummaryScreen } from './summary-screen';

export const metadata: Metadata = { title: 'Attendance summary' };

export default function AttendanceSummaryPage() {
  return <SummaryScreen />;
}
