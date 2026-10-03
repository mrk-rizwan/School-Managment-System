import type { Metadata } from 'next';
import { StaffList } from './staff-list';

export const metadata: Metadata = { title: 'Staff' };

export default function StaffPage() {
  return <StaffList />;
}
