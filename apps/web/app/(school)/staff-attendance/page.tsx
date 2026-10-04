import type { Metadata } from 'next';
import { StaffAttendanceScreen } from './staff-day-sheet';

export const metadata: Metadata = { title: 'Staff attendance' };

export default function StaffAttendancePage() {
  return <StaffAttendanceScreen />;
}
