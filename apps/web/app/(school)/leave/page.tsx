import type { Metadata } from 'next';
import { LeaveScreen } from './leave-screen';

export const metadata: Metadata = { title: 'Staff leave' };

export default function LeavePage() {
  return <LeaveScreen />;
}
