import type { Metadata } from 'next';
import { CreateStaffForm } from './create-staff-form';

export const metadata: Metadata = { title: 'New staff member' };

export default function NewStaffPage() {
  return <CreateStaffForm />;
}
