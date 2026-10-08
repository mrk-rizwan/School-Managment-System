'use client';

import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState, LoadingState, StateCard } from '@/components/page-states';
import { useSchoolMe } from '@/lib/school-session';

/** The guardian's live login children (GET /me), each a link to their results. */
export function MyChildrenResultsList() {
  const me = useSchoolMe();
  const children = me.data?.children ?? [];
  if (me.isPending) return <LoadingState />;
  if (children.length === 0) {
    return (
      <StateCard>
        <EmptyState title="No children are linked to your account" description="Ask the school office." />
      </StateCard>
    );
  }
  return (
    <ul className="grid gap-2 sm:max-w-md">
      {children.map((child) => (
        <li key={child.studentId}>
          <Link
            href={`/my-children/${child.studentId}/results`}
            className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            {child.fullName}
            <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
