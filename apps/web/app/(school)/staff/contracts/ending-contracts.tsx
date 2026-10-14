'use client';

import { addDaysTo, formatDay, todayInSchool } from '@asms/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { BackLink, EmptyState, QueryStates, StateCard } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { staffContractsApi } from '@/lib/api/school-staff-contracts-contract';
import { useListPage } from '@/lib/hooks';
import { CONTRACT_TYPE_LABELS, contractKeys, ContractStatusBadge } from '../[id]/contracts-tab';

// Live contracts ending within 30 days, and expired ones not yet ended (phase-5-extended.md slice
// 39, R320; contracts/slice-39.md §2.6): the dashboard tile's list. Each row opens the staff
// member's Contracts tab, where renew, end and End employment are.

const LIMIT = 25;
/** The tile's horizon (rule 35's default warning lead). */
export const ENDING_WITHIN_DAYS = 30;

export function EndingContracts() {
  const endsBy = addDaysTo(todayInSchool(), ENDING_WITHIN_DAYS);
  const [page, setPage] = useListPage([endsBy]);
  const contracts = useQuery({
    queryKey: [...contractKeys.ending, endsBy, page],
    queryFn: () => unwrap(staffContractsApi.GET('/api/v1/staff-contracts', { params: { query: { endsBy, page, limit: LIMIT } } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <BackLink href="/staff">Staff</BackLink>
      <PageHeader
        title="Contracts ending"
        description={`Current contracts whose last day is on or before ${formatDay(endsBy)}, and expired ones not yet ended. Nothing changes on its own: renew each or end employment.`}
      />
      <QueryStates query={contracts}>
        {(data) =>
          data.data.length === 0 ? (
            <StateCard>
              <EmptyState title="No contract is ending" description={`No current contract ends within ${ENDING_WITHIN_DAYS} days.`} />
            </StateCard>
          ) : (
            <div className="grid gap-3">
              <div className="overflow-x-auto rounded-lg border bg-card" data-testid="contracts.ending">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Staff member</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Last day</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Days left</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.data.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell>
                          <Link href={`/staff/${c.staffId}?tab=contracts`} className="font-medium underline-offset-4 hover:underline">
                            {c.staffName}
                          </Link>
                        </TableCell>
                        <TableCell>{CONTRACT_TYPE_LABELS[c.type]}</TableCell>
                        <TableCell>{c.endsOn ? formatDay(c.endsOn) : '—'}</TableCell>
                        <TableCell>
                          <ContractStatusBadge status={c.status} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{c.daysLeft ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex gap-2">
                {page > 1 && (
                  <Button variant="ghost" onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                )}
                {data.total > page * LIMIT && (
                  <Button variant="outline" onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                )}
              </div>
            </div>
          )
        }
      </QueryStates>
    </>
  );
}
