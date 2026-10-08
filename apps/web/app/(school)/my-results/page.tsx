import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { ResultsView } from './_lib/my-results-ui';

export const metadata: Metadata = { title: 'My results' };

// The student's own results (contracts/slice-33.md §5): read by the browser through /me/student/*
// with the student's session; the student is the session's, never a parameter.
export default function MyResultsPage() {
  return (
    <>
      <PageHeader title="My results" description="Your published term results, report cards and class tests." />
      <ResultsView source={{ kind: 'student' }} />
    </>
  );
}
