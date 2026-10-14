'use client';

import { Capability, formatDay } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ErrorState, LoadingState } from '@/components/page-states';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { transportApi } from '@/lib/api/school-transport-contract';
import { useCapabilities } from '@/lib/school-session';
import { AssignmentStatusBadge, routeHref, stopLabel, transportKeys } from '../../transport/_lib/transport-ui';

// The student page's Transport card (contracts/slice-41.md §1, §3): the current route, stop and
// pickup time, and the earlier ones. Read with student.view in scope or transport.manage; the
// route links to its page for transport.manage holders.

export function TransportCard({ studentId }: { studentId: string }) {
  const { can } = useCapabilities();
  const manage = can(Capability.TRANSPORT_MANAGE);
  const transport = useQuery({
    queryKey: transportKeys.student(studentId),
    queryFn: () => unwrap(transportApi.GET('/api/v1/students/{id}/transport', { params: { path: { id: studentId } } })),
  });

  return (
    <Card data-testid="student.transport">
      <CardHeader>
        <CardTitle className="text-base">Transport</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {transport.isPending ? (
          <LoadingState rows={2} />
        ) : transport.isError ? (
          <ErrorState error={transport.error} onRetry={() => void transport.refetch()} />
        ) : transport.data.current === null ? (
          <p className="text-muted-foreground">
            Does not use school transport.{manage ? ' Assign a route from Transport.' : ''}
          </p>
        ) : (
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {manage ? (
                <Link href={routeHref(transport.data.current.routeId)} className="font-medium underline-offset-4 hover:underline">
                  {transport.data.current.routeName}
                </Link>
              ) : (
                <span className="font-medium">{transport.data.current.routeName}</span>
              )}
              <AssignmentStatusBadge status={transport.data.current.status} />
            </div>
            <p>{stopLabel(transport.data.current.stopName, transport.data.current.pickupTime)}</p>
            <p className="text-muted-foreground">
              From {formatDay(transport.data.current.startsOn)}
              {transport.data.current.endsOn ? ` to ${formatDay(transport.data.current.endsOn)}` : ''}
            </p>
          </div>
        )}
        {transport.data && transport.data.history.length > 0 && (
          <div className="grid gap-1 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">Earlier</p>
            <ul className="grid gap-1">
              {transport.data.history.map((h) => (
                <li key={h.id} className="text-muted-foreground">
                  {h.routeName}: {formatDay(h.startsOn)}
                  {h.endsOn ? ` – ${formatDay(h.endsOn)}` : ''}
                  {h.endReason ? ` (${h.endReason})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
