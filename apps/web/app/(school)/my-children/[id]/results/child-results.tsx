'use client';

import { PageHeader } from '@/components/app-shell';
import { BackLink, EmptyState, LoadingState, StateCard } from '@/components/page-states';
import { useSchoolMe } from '@/lib/school-session';
import { ResultsView } from '../../../my-results/_lib/my-results-ui';

/**
 * One child's results for a guardian (contracts/slice-33.md §5). The child must be one of the
 * guardian's live login children (GET /me); the API answers 404 for any other id regardless.
 */
export function ChildResults({ studentId }: { studentId: string }) {
  const me = useSchoolMe();
  if (me.isPending) return <LoadingState />;
  const child = me.data?.children.find((c) => c.studentId === studentId);
  return (
    <>
      <BackLink href="/my-children/results">Children&apos;s results</BackLink>
      {child ? (
        <>
          <PageHeader title={child.fullName} description="Published term results, report cards and class tests." />
          <ResultsView key={studentId} source={{ kind: 'guardian', studentId }} />
        </>
      ) : (
        <StateCard>
          <EmptyState title="Child not found" description="Pick one of your children from the list." />
        </StateCard>
      )}
    </>
  );
}
