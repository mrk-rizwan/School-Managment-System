'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryStates } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { myResultsApi } from '@/lib/api/school-my-results-contract';
import { myResultsKeys, ReportCard } from '../../my-results/_lib/my-results-ui';

const LIMIT = 5;

/**
 * The student page's Results tab (contracts/slice-33.md §1, R288): every published, live report
 * card across years, newest first. Staff reads are never withheld.
 */
export function ResultsPanel({ studentId }: { studentId: string }) {
  const [page, setPage] = useState(1);
  const results = useQuery({
    queryKey: myResultsKeys.student(studentId, page),
    queryFn: () =>
      unwrap(
        myResultsApi.GET('/api/v1/students/{id}/results', {
          params: { path: { id: studentId }, query: { page, limit: LIMIT } },
        }),
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <QueryStates query={results} loadingRows={4}>
      {(data) =>
        data.data.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Results</CardTitle>
              <CardDescription>No result of this student has been published.</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="grid gap-4">
            {data.data.map((r) => (
              <ReportCard key={r.id} result={r} />
            ))}
            {data.total > LIMIT && (
              <Card>
                <CardContent className="flex items-center justify-end gap-2 pt-6">
                  <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    Newer
                  </Button>
                  <Button variant="outline" size="sm" disabled={page * LIMIT >= data.total} onClick={() => setPage(page + 1)}>
                    Older
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        )
      }
    </QueryStates>
  );
}
