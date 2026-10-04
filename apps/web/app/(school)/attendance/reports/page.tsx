import type { Metadata } from 'next';
import { ReportsScreen } from './reports-screen';

export const metadata: Metadata = { title: 'Attendance reports' };

export default function AttendanceReportsPage() {
  return <ReportsScreen />;
}
