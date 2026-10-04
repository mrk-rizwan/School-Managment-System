import type { Metadata } from 'next';
import { MyAttendance } from './my-attendance';

export const metadata: Metadata = { title: 'My attendance' };

export default function MyAttendancePage() {
  return <MyAttendance />;
}
