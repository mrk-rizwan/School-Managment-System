'use client';

import { addDaysTo, Capability, ErrorCode, formatDay, newIdempotencyKey, todayInSchool } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileTextIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { refusalMessage, toApiError, toastApiError, type RefusalMessages } from '@/lib/api/errors';
import {
  staffContractsApi,
  type ContractType,
  type CreateStaffContractBody,
  type StaffContractDto,
  type StaffContractStatus,
} from '@/lib/api/school-staff-contracts-contract';
import type { StaffDto } from '@/lib/api/school-staff-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { ACCEPT_ATTRIBUTE, ACCEPTED_TYPES, MAX_UPLOAD_BYTES, saveBlob, uploadFile } from '../../students/_lib/documents';

// A staff member's contracts (phase-5-extended.md slice 39, contracts/slice-39.md §6): the list,
// add, renew, end, the scan, and "End employment" (the existing status change to `left`, which
// also ends the live contract). staff.contract.manage only; the API decides every refusal.

const LIMIT = 10;

export const contractKeys = {
  all: ['school', 'staff-contracts'] as const,
  forStaff: (staffId: string) => ['school', 'staff-contracts', 'staff', staffId] as const,
  ending: ['school', 'staff-contracts', 'ending'] as const,
};

export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  permanent: 'Permanent',
  fixed_term: 'Fixed term',
  probation: 'Probation',
};

const STATUS_LABELS: Record<StaffContractStatus, string> = {
  live: 'Current',
  upcoming: 'Starts later',
  expired: 'Expired, not ended',
  ended: 'Ended',
};
const STATUS_VARIANT = {
  live: 'secondary',
  upcoming: 'outline',
  expired: 'destructive',
  ended: 'ghost',
} as const satisfies Record<StaffContractStatus, string>;

export function ContractStatusBadge({ status }: { status: StaffContractStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABELS[status]}</Badge>;
}

const REFUSALS: RefusalMessages = {
  [ErrorCode.STAFF_CONTRACT_LIVE_EXISTS]: 'This staff member already has a current contract. Renew or end it first.',
  [ErrorCode.STAFF_CONTRACT_ENDED]: 'This contract has already ended.',
  [ErrorCode.ILLEGAL_STATUS_TRANSITION]: (d) =>
    d.status === 'left' ? 'This staff member has left. Re-hire them before adding a contract.' : 'A permanent contract has no end to renew from. End it and add a new contract.',
};

/** "1 Jan 2026 – 31 Dec 2026", or "From 1 Jan 2026" for a permanent contract. */
const rangeOf = (c: Pick<StaffContractDto, 'startsOn' | 'endsOn'>) =>
  c.endsOn ? `${formatDay(c.startsOn)} – ${formatDay(c.endsOn)}` : `From ${formatDay(c.startsOn)}`;

function remaining(c: StaffContractDto): string | null {
  if (c.daysLeft === null) return null;
  if (c.daysLeft < 0) return `Ended its term ${-c.daysLeft} ${c.daysLeft === -1 ? 'day' : 'days'} ago`;
  if (c.daysLeft === 0) return 'Last day today';
  return `${c.daysLeft} ${c.daysLeft === 1 ? 'day' : 'days'} left`;
}

/** GET /staff-contracts/:id/document, streamed by the API, saved under its own name. */
async function downloadScan(c: StaffContractDto): Promise<void> {
  const { data, error, response } = await staffContractsApi.GET('/api/v1/staff-contracts/{id}/document', {
    params: { path: { id: c.id } },
    parseAs: 'blob',
  });
  if (!response.ok || !data) {
    toastApiError(toApiError(response, error));
    return;
  }
  saveBlob(data, response, `contract-${c.id}`);
}

type Editing = { mode: 'add' } | { mode: 'renew'; from: StaffContractDto };

export function ContractsTab({
  staff,
  canEndEmployment,
  onEndEmployment,
}: {
  staff: StaffDto;
  canEndEmployment: boolean;
  onEndEmployment: () => void;
}) {
  const { can } = useCapabilities();
  const queryClient = useQueryClient();
  const manage = can(Capability.STAFF_CONTRACT_MANAGE);
  const [page, setPage] = useListPage([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [ending, setEnding] = useState<StaffContractDto | null>(null);
  const contracts = useQuery({
    queryKey: [...contractKeys.forStaff(staff.id), page],
    queryFn: () =>
      unwrap(
        staffContractsApi.GET('/api/v1/staff/{id}/contracts', { params: { path: { id: staff.id }, query: { page, limit: LIMIT } } }),
      ),
    placeholderData: keepPreviousData,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: contractKeys.all });
  const open = contracts.data?.data.find((c) => c.status !== 'ended');

  return (
    <div className="grid gap-4" data-testid="staff.contracts">
      {manage && !open && staff.status !== 'left' && contracts.isSuccess && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing({ mode: 'add' })}>Add contract</Button>
        </div>
      )}
      {contracts.isPending ? (
        <LoadingState rows={3} />
      ) : contracts.isError ? (
        <ErrorState error={contracts.error} onRetry={() => void contracts.refetch()} />
      ) : contracts.data.data.length === 0 ? (
        <EmptyState
          title="No contract recorded"
          description={
            staff.status === 'left'
              ? 'This person has left. Re-hire them before adding a contract.'
              : 'Record the terms of employment: permanent, fixed term or probation.'
          }
        />
      ) : (
        <>
          {contracts.data.data.map((c) => (
            <ContractCard
              key={c.id}
              contract={c}
              actions={
                manage && c.status !== 'ended' ? (
                  <>
                    {c.endsOn && (
                      <Button size="sm" onClick={() => setEditing({ mode: 'renew', from: c })}>
                        Renew
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setEnding(c)}>
                      End contract
                    </Button>
                    {canEndEmployment && staff.status !== 'left' && (
                      <Button size="sm" variant="destructive" onClick={onEndEmployment}>
                        End employment
                      </Button>
                    )}
                  </>
                ) : null
              }
            />
          ))}
          <div className="flex gap-2">
            {page > 1 && (
              <Button variant="ghost" onClick={() => setPage(page - 1)}>
                Newer
              </Button>
            )}
            {contracts.data.total > page * LIMIT && (
              <Button variant="outline" onClick={() => setPage(page + 1)}>
                Older
              </Button>
            )}
          </div>
        </>
      )}
      {editing && (
        <ContractDialog
          staff={staff}
          editing={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            toast.success(editing.mode === 'renew' ? 'Contract renewed.' : 'Contract added.');
            setEditing(null);
            refresh();
          }}
        />
      )}
      {ending && (
        <EndContractDialog
          contract={ending}
          onClose={() => setEnding(null)}
          onDone={() => {
            toast.success('Contract ended.');
            setEnding(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ContractCard({ contract: c, actions }: { contract: StaffContractDto; actions: React.ReactNode }) {
  const left = remaining(c);
  return (
    <Card className={c.status === 'ended' ? 'opacity-70' : undefined} data-testid={`staff.contract.${c.id}`}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">
          {CONTRACT_TYPE_LABELS[c.type]} · {rangeOf(c)}
        </CardTitle>
        <ContractStatusBadge status={c.status} />
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">
        {left && <p className={c.status === 'expired' ? 'text-destructive' : 'text-muted-foreground'}>{left}</p>}
        {c.status === 'expired' && (
          <p className="text-muted-foreground">Nothing changes on its own: renew the contract or end employment.</p>
        )}
        {c.endedOn && (
          <p className="text-muted-foreground">
            Ended on {formatDay(c.endedOn)}
            {c.endReason === 'renewed' ? ' (renewed)' : c.endReason === 'left' ? ' (employment ended)' : `: ${c.endReason ?? ''}`}
            {c.endedByName ? `, by ${c.endedByName}` : ''}
          </p>
        )}
        {c.note && <p>{c.note}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          {c.hasDocument && (
            <Button size="sm" variant="ghost" onClick={() => void downloadScan(c)}>
              <FileTextIcon />
              View scan
            </Button>
          )}
          {actions}
        </div>
      </CardContent>
    </Card>
  );
}

const fileProblem = (file: File | null): string | null => {
  if (file === null) return null;
  if (!ACCEPTED_TYPES.includes(file.type)) return 'Choose a JPEG, PNG or PDF file.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than 5 MB.';
  return null;
};

function ContractDialog({
  staff,
  editing,
  onClose,
  onDone,
}: {
  staff: StaffDto;
  editing: Editing;
  onClose: () => void;
  onDone: () => void;
}) {
  const renewFrom = editing.mode === 'renew' ? editing.from : null;
  // A renewal starts the day after the current contract's last day (R318).
  const fixedStart = renewFrom?.endsOn ? addDaysTo(renewFrom.endsOn, 1) : null;
  const [key] = useState(newIdempotencyKey);
  const [type, setType] = useState<ContractType>(renewFrom?.type ?? 'fixed_term');
  const [startsOn, setStartsOn] = useState(fixedStart ?? todayInSchool());
  const [endsOn, setEndsOn] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { type: useId(), starts: useId(), ends: useId(), note: useId(), file: useId() };
  const needsEnd = type !== 'permanent';
  const problem = fileProblem(file);
  const valid = startsOn !== '' && (!needsEnd || (endsOn !== '' && endsOn >= startsOn)) && problem === null;

  const save = useMutation({
    mutationFn: async () => {
      const stagedUploadId = file ? (await uploadFile(file)).id : undefined;
      const body: CreateStaffContractBody = {
        type,
        startsOn,
        ...(needsEnd ? { endsOn } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(stagedUploadId ? { stagedUploadId } : {}),
      };
      return renewFrom
        ? unwrap(staffContractsApi.POST('/api/v1/staff-contracts/{id}/renew', { params: { path: { id: renewFrom.id } }, body }))
        : unwrap(
            staffContractsApi.POST('/api/v1/staff/{id}/contracts', {
              params: { path: { id: staff.id }, header: { 'Idempotency-Key': key } },
              body,
            }),
          );
    },
    onSuccess: onDone,
    onError: (e) => setError(refusalMessage(e, REFUSALS)),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{renewFrom ? `Renew contract: ${staff.fullName}` : `New contract: ${staff.fullName}`}</DialogTitle>
            <DialogDescription>
              {renewFrom?.endsOn
                ? `The current contract ends on ${formatDay(renewFrom.endsOn)} and the new one starts the next day. A contract is never edited; pay stays in the salary.`
                : 'A contract is never edited: a change is a renewal. Pay stays in the salary.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.type}>Type</Label>
              <NativeSelect id={ids.type} value={type} onChange={(e) => setType(e.target.value as ContractType)}>
                {Object.entries(CONTRACT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.starts}>Starts on</Label>
              <Input id={ids.starts} type="date" value={startsOn} disabled={fixedStart !== null} onChange={(e) => setStartsOn(e.target.value)} />
            </div>
            {needsEnd && (
              <div className="grid gap-1.5">
                <Label htmlFor={ids.ends}>Last working day</Label>
                <Input id={ids.ends} type="date" min={startsOn} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
              </div>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.note}>Note (optional, staff do not see it)</Label>
            <Input id={ids.note} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.file}>Signed contract (optional: JPEG, PNG or PDF, up to 5 MB)</Label>
            <Input
              id={ids.file}
              type="file"
              accept={ACCEPT_ATTRIBUTE}
              aria-invalid={problem ? true : undefined}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {problem && <p className="text-xs text-destructive">{problem}</p>}
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? 'Saving…' : renewFrom ? 'Renew' : 'Add contract'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EndContractDialog({ contract, onClose, onDone }: { contract: StaffContractDto; onClose: () => void; onDone: () => void }) {
  const today = todayInSchool();
  const latest = contract.endsOn && contract.endsOn < today ? contract.endsOn : today;
  const [endedOn, setEndedOn] = useState(latest < contract.startsOn ? contract.startsOn : latest);
  const dateId = useId();
  const end = useMutation({
    mutationFn: (reason: string) =>
      unwrap(staffContractsApi.POST('/api/v1/staff-contracts/{id}/end', { params: { path: { id: contract.id } }, body: { endedOn, reason } })),
    onSuccess: onDone,
  });
  return (
    <ConfirmWithReasonDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={`End contract: ${contract.staffName}`}
      description="Ending a contract changes nothing else: to stop employment, use End employment."
      confirmLabel="End contract"
      minLength={3}
      maxLength={500}
      destructive
      pending={end.isPending}
      confirmDisabled={endedOn === '' || endedOn < contract.startsOn || (contract.endsOn !== null && endedOn > contract.endsOn)}
      onConfirm={(reason) => end.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={dateId}>Actual last day</Label>
        <Input id={dateId} type="date" min={contract.startsOn} max={contract.endsOn ?? undefined} value={endedOn} onChange={(e) => setEndedOn(e.target.value)} />
      </div>
      {end.error && (
        <Alert variant="destructive">
          <AlertDescription>{refusalMessage(end.error, REFUSALS)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
