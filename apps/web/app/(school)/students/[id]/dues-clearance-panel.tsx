'use client';

import { Capability, ErrorCode, formatRupees } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { QueryStates } from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { refusalMessage } from '@/lib/api/errors';
import { reportsApi } from '@/lib/api/school-reports-contract';
import { formatDate, formatDateTime } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { feesKeys, useIsPrincipal } from '../../fees/_lib/fees-ui';

/** The student's dues across every academic year (slice 22): one key, so the panel and the status dialog share it. */
export const duesClearanceKey = (studentId: string) => [...feesKeys.all, 'dues-clearance', studentId] as const;

/** GET /students/:id/dues-clearance, while `enabled`. */
export function useDuesClearance(studentId: string, enabled = true) {
  return useQuery({
    queryKey: duesClearanceKey(studentId),
    queryFn: () =>
      unwrap(reportsApi.GET('/api/v1/students/{id}/dues-clearance', { params: { path: { id: studentId } } })),
    enabled,
  });
}

/**
 * Dues clearance (slice 22, rule 20): what the student owes across every year, which blocks a
 * leaving certificate until it is paid or a principal overrides with a reason (audited). Shown
 * to fee.statement.view holders; the override needs certificate.issue and the principal role.
 */
export function DuesClearancePanel({ studentId }: { studentId: string }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const principal = useIsPrincipal();
  const canOverride = principal && can(Capability.CERTIFICATE_ISSUE);
  const [overriding, setOverriding] = useState(false);
  const clearance = useDuesClearance(studentId);
  const override = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        reportsApi.POST('/api/v1/students/{id}/dues-clearance/override', {
          params: { path: { id: studentId } },
          body: { reason },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(duesClearanceKey(studentId), updated);
      toast.success('Dues override recorded.');
      setOverriding(false);
    },
    onError: (error) =>
      toast.error(
        refusalMessage(error, {
          [`${ErrorCode.PERMISSION_DENIED}:principal_required`]: 'Only a principal can override unpaid dues.',
          [`${ErrorCode.SELF_ACTION_FORBIDDEN}:own_child`]: "You cannot override your own child's dues. Another principal must decide.",
        }),
      ),
  });

  return (
    <QueryStates query={clearance} loadingRows={2}>
      {(data) => (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              Dues clearance
              {data.cleared ? <Badge variant="secondary">Cleared</Badge> : <Badge variant="destructive">Not cleared</Badge>}
            </CardTitle>
            <CardDescription>
              {data.outstanding > 0
                ? `Owes ${formatRupees(data.outstanding)} across all years. A leaving certificate needs the dues paid or a principal's override.`
                : 'Nothing is owed in any year.'}
              {data.advance > 0 && ` Advance held: ${formatRupees(data.advance)}.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {data.openCharges.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-3 text-muted-foreground">Fee</TableHead>
                      <TableHead className="px-3 text-muted-foreground">Class</TableHead>
                      <TableHead className="px-3 text-muted-foreground">Due</TableHead>
                      <TableHead className="px-3 text-right text-muted-foreground">Owed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.openCharges.map((charge) => (
                      <TableRow key={charge.id}>
                        <TableCell className="px-3">
                          <span className="flex flex-col">
                            <span>{charge.description}</span>
                            <span className="text-xs text-muted-foreground">{charge.feeHeadName}</span>
                          </span>
                        </TableCell>
                        <TableCell className="px-3">{`${charge.className} ${charge.sectionName}`}</TableCell>
                        <TableCell className="px-3">{formatDate(charge.dueOn)}</TableCell>
                        <TableCell className="px-3 text-right tabular-nums">{formatRupees(charge.outstanding)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {data.override && (
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-medium">
                  Overridden by {data.override.byName} on {formatDateTime(data.override.at)}
                </p>
                <p className="text-muted-foreground">{data.override.reason}</p>
              </div>
            )}
            {canOverride && !data.cleared && data.outstanding > 0 && (
              <div>
                <Button variant="outline" onClick={() => setOverriding(true)}>
                  Override
                </Button>
              </div>
            )}
          </CardContent>
          <ConfirmWithReasonDialog
            open={overriding}
            onOpenChange={setOverriding}
            title="Override unpaid dues"
            description={`Lets a leaving certificate be issued while ${formatRupees(data.outstanding)} is still owed. The dues stay owing; the override and its reason are recorded.`}
            confirmLabel="Override"
            minLength={3}
            maxLength={500}
            destructive
            pending={override.isPending}
            onConfirm={(reason) => override.mutate(reason)}
          />
        </Card>
      )}
    </QueryStates>
  );
}
