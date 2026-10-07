import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { CertificateRegister } from './certificate-register';

export const metadata: Metadata = { title: 'Certificates' };

// Certificates (phase-4-academic.md slice 34). Data is fetched by the browser (plan §1).
export default function CertificatesPage() {
  return (
    <>
      <PageHeader
        title="Certificates"
        description="Leaving, character, academic and completion certificates, numbered per type. A duplicate keeps the original's number."
      />
      <CertificateRegister />
    </>
  );
}
