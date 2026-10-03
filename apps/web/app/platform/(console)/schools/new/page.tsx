import type { Metadata } from 'next';
import { CreateSchoolForm } from './create-school-form';

export const metadata: Metadata = { title: 'New school' };

export default function NewSchoolPage() {
  return <CreateSchoolForm />;
}
