'use client';

import { Capability } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldOffIcon } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { toastApiError } from '@/lib/api/errors';
import { schoolSupportApi, type SchoolSupportSessionDto } from '@/lib/api/school-support-contract';
import { formatDateTime } from '@/lib/format';
import { schoolKeys, useCapabilities } from '@/lib/school-session';

// Phase 5 slice 45 (rule 40, contracts/slice-45.md §1): every ASMS support session on this school,
// newest first. The open one can be ended here at once; the next read support makes is refused.
// Every read a session made is in the audit log, filtered by the session.

const supportKeys = ['school', 'support-sessions'] as const;

const ENDED: Record<string, string> = { closed: 'Closed by support', revoked: 'Ended by the school', expired: 'Expired' };

export function SupportSessionsCard() {
  const { can } = useCapabilities();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<SchoolSupportSessionDto | null>(null);
  const enabled = can(Capability.SCHOOL_SETTINGS_MANAGE);
  const sessions = useQuery({
    queryKey: supportKeys,
    queryFn: () =>
      unwrap(schoolSupportApi.GET('/api/v1/school/support-sessions', { params: { query: { page: 1, limit: 10 } } })),
    enabled,
  });

  const revoke = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(
        schoolSupportApi.POST('/api/v1/school/support-sessions/{id}/revoke', { params: { path: { id } }, body: { reason } }),
      ),
    onSuccess: () => {
      toast.success('Support access ended.');
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: supportKeys });
      void queryClient.invalidateQueries({ queryKey: schoolKeys.me });
    },
    onError: (error) => {
      setRevoking(null);
      toastApiError(error);
      void queryClient.invalidateQueries({ queryKey: supportKeys });
    },
  });

  if (!enabled) return null;
  const canAudit = can(Capability.AUDIT_VIEW);

  return (
    <Card id="support-sessions" data-testid="support-sessions-card">
      <CardHeader>
        <CardTitle>ASMS support access</CardTitle>
        <CardDescription>
          When you ask ASMS support for help, they may open read-only access to this school for a few hours. You are
          told when it opens and ends, and every record they read is in the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {sessions.isPending ? (
          <LoadingState rows={2} />
        ) : sessions.error ? (
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
        ) : sessions.data.data.length === 0 ? (
          <EmptyState title="No support access yet" description="ASMS support has never opened access to this school." />
        ) : (
          <ul className="divide-y" aria-label="Support sessions">
            {sessions.data.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium break-all">{s.supportName}</span>
                    {s.status === 'open' ? (
                      <Badge>Open until {formatDateTime(s.expiresAt)}</Badge>
                    ) : (
                      <Badge variant="secondary">{ENDED[s.endKind ?? 'expired'] ?? 'Ended'}</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground">
                    {formatDateTime(s.openedAt)} · ticket {s.ticketRef} · {s.reason}
                  </p>
                  {s.revokeReason && <p className="text-muted-foreground">Ended because: {s.revokeReason}</p>}
                  {canAudit && (
                    <Link
                      className="underline-offset-4 hover:underline"
                      href={`/audit?subjectType=support_session&subjectId=${s.id}`}
                    >
                      What support read
                    </Link>
                  )}
                </div>
                {s.status === 'open' && (
                  <Button variant="outline" size="sm" onClick={() => setRevoking(s)}>
                    <ShieldOffIcon />
                    End access now
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmWithReasonDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="End ASMS support access?"
        description="Support loses access at once; their next read is refused. The reason is recorded in the audit log."
        confirmLabel="End access"
        minLength={3}
        destructive
        pending={revoke.isPending}
        onConfirm={(reason) => revoking && revoke.mutate({ id: revoking.id, reason })}
      />
    </Card>
  );
}
