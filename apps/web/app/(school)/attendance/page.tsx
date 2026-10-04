import type { Metadata } from 'next';
import { RegistersScreen } from './registers-screen';

export const metadata: Metadata = { title: 'Attendance' };

export default function AttendancePage() {
  return <RegistersScreen />;
}
