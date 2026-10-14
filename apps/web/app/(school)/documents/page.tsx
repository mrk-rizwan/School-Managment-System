import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { DocumentsQueue } from './documents-queue';

export const metadata: Metadata = { title: 'Documents' };

// Document verification (Phase 5 slice 40). Data is fetched by the browser (plan §1).
export default function DocumentsPage() {
  return (
    <>
      <PageHeader
        title="Documents"
        description="Check the documents uploaded for students. A missing or rejected document never stops an admission; it is a query on the student."
      />
      <DocumentsQueue />
    </>
  );
}
