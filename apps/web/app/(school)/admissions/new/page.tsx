import type { Metadata } from 'next';
import { AdmissionWizardPage } from './admission-wizard';

export const metadata: Metadata = { title: 'New admission' };

export default function NewAdmissionPage() {
  return <AdmissionWizardPage />;
}
