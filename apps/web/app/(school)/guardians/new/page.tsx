import type { Metadata } from 'next';
import { CreateGuardianForm } from './create-guardian-form';

export const metadata: Metadata = { title: 'New guardian' };

export default function NewGuardianPage() {
  return <CreateGuardianForm />;
}
