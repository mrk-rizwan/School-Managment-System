'use client';

import { Capability, ErrorCode } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures, RowActions } from '@/components/data-table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { unwrap } from '@/lib/api/client';
import { ApiError, describeApiError } from '@/lib/api/errors';
import type { GuardianLookupHitDto } from '@/lib/api/school-guardians-contract';
import {
  studentsApi,
  type GuardianLinkDto,
  type Relationship,
  type StudentDetailDto,
  type UpdateGuardianLinkBody,
} from '@/lib/api/school-students-contract';
import { formatDate } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { guardiansKeys } from '../../guardians/_lib/guardians-ui';
import { GuardianFinder } from '../_lib/guardian-finder';
import { LinkFlagFields, type LinkFlags as Flags } from '../_lib/link-flags';
import { RELATIONSHIP_LABELS, studentsKeys } from '../_lib/students-ui';

const LIMIT = 25;

/**
 * contracts/slice-6.md §4 (rule 9, R28–R30): one primary contact with a phone, at least one fee
 * payer. A teacher sees name, relationship, phone and the flags only (the API nulls the rest).
 */
export function GuardianLinksTab({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const canManage = can(Capability.GUARDIAN_MANAGE);
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<GuardianLinkDto | null>(null);
  const [ending, setEnding] = useState<GuardianLinkDto | null>(null);

  const query = { page, limit: LIMIT, includeEnded } as const;
  const links = useQuery({
    queryKey: [...studentsKeys.links(student.id), query],
    queryFn: () =>
      unwrap(
        studentsApi.GET('/api/v1/students/{id}/guardian-links', {
          params: { path: { id: student.id }, query },
        }),
      ),
    placeholderData: keepPreviousData,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: studentsKeys.links(student.id) });
    void queryClient.invalidateQueries({ queryKey: guardiansKeys.all });
  };

  const live = (links.data?.data ?? []).filter((l) => l.endedAt === null);
  const feePayers = live.filter((l) => l.isFeePayer).length;

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, GuardianLinkDto>();
    return [
      column.accessor('guardianFullName', {
        header: 'Guardian',
        cell: (info) =>
          canManage ? (
            <Link
              href={`/guardians/${info.row.original.guardianId}`}
              className="font-medium underline-offset-4 hover:underline"
            >
              {info.getValue()}
            </Link>
          ) : (
            <span className="font-medium">{info.getValue()}</span>
          ),
      }),
      column.accessor('relationship', {
        header: 'Relationship',
        cell: (info) => RELATIONSHIP_LABELS[info.getValue()],
      }),
      column.accessor('phone', {
        header: 'Phone',
        cell: (info) => info.getValue() ?? <span className="text-muted-foreground">No phone</span>,
      }),
      column.display({
        id: 'flags',
        header: 'Role',
        cell: (info) => {
          const link = info.row.original;
          return (
            <span className="flex flex-wrap gap-1">
              {link.isPrimaryContact && <Badge variant="secondary">Primary contact</Badge>}
              {link.isFeePayer && <Badge variant="outline">Fee payer</Badge>}
              {link.canLogin && <Badge variant="outline">May log in</Badge>}
              {link.endedAt && <Badge variant="ghost">Ended {formatDate(link.endedAt)}</Badge>}
            </span>
          );
        },
      }),
      ...(canManage
        ? [
            column.display({
              id: 'actions',
              header: () => <span className="sr-only">Actions</span>,
              cell: (info) => {
                const link = info.row.original;
                if (link.endedAt) return null;
                return (
                  <RowActions
                    label={link.guardianFullName}
                    actions={[
                      { label: 'Edit link', onSelect: () => setEditing(link) },
                      { label: 'End link', onSelect: () => setEnding(link), destructive: true },
                    ]}
                  />
                );
              },
            }),
          ]
        : []),
    ];
  }, [canManage]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex h-8 items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={includeEnded}
            onChange={(event) => setIncludeEnded(event.target.checked)}
          />
          Show ended links
        </label>
        {canManage && (
          <Button onClick={() => setAdding(true)}>
            <PlusIcon />
            Link a guardian
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        query={links}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No guardians linked"
      />
      {canManage && (
        <>
          <AddLinkDialog
            student={student}
            linkedIds={new Set(live.map((l) => l.guardianId))}
            open={adding}
            onOpenChange={setAdding}
            onDone={refresh}
          />
          <EditLinkDialog link={editing} feePayers={feePayers} onClose={() => setEditing(null)} onDone={refresh} />
          <EndLinkDialog link={ending} feePayers={feePayers} onClose={() => setEnding(null)} onDone={refresh} />
        </>
      )}
    </div>
  );
}

function AddLinkDialog({
  student,
  linkedIds,
  open,
  onOpenChange,
  onDone,
}: {
  student: StudentDetailDto;
  linkedIds: ReadonlySet<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && (
          <AddLinkForm student={student} linkedIds={linkedIds} onClose={() => onOpenChange(false)} onDone={onDone} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddLinkForm({
  student,
  linkedIds,
  onClose,
  onDone,
}: {
  student: StudentDetailDto;
  linkedIds: ReadonlySet<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [picked, setPicked] = useState<GuardianLookupHitDto | null>(null);
  const [flags, setFlags] = useState<Flags>({
    relationship: '',
    isPrimaryContact: false,
    isFeePayer: false,
    canLogin: false,
  });
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        studentsApi.POST('/api/v1/students/{id}/guardian-links', {
          params: { path: { id: student.id } },
          body: {
            guardianId: picked!.guardian.id,
            relationship: flags.relationship as Relationship,
            isPrimaryContact: flags.isPrimaryContact,
            isFeePayer: flags.isFeePayer,
            canLogin: flags.canLogin,
          },
        }),
      ),
    onSuccess: (link) => {
      toast.success(`${link.guardianFullName} linked to ${student.fullName}.`);
      onDone();
      onClose();
    },
  });

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Link a guardian to {student.fullName}</DialogTitle>
        <DialogDescription>
          Find the guardian first, so a family is never recorded twice.
        </DialogDescription>
      </DialogHeader>
      {picked ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (flags.relationship && !add.isPending) add.mutate();
          }}
        >
          <p className="text-sm">
            Linking <span className="font-medium">{picked.guardian.fullName}</span>.{' '}
            <button
              type="button"
              className="underline underline-offset-4"
              disabled={add.isPending}
              onClick={() => {
                add.reset();
                setPicked(null);
              }}
            >
              Choose someone else
            </button>
          </p>
          <LinkFlagFields value={flags} onChange={setFlags} hasPhone={picked.guardian.hasPhone} disabled={add.isPending} />
          {add.error && (
            <Alert variant="destructive">
              <AlertDescription>{linkErrorText(add.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={add.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!flags.relationship || add.isPending}>
              {add.isPending ? 'Linking…' : 'Link guardian'}
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <GuardianFinder
          pickedIds={linkedIds}
          onPick={setPicked}
          noMatchHint={
            <p className="text-sm text-muted-foreground">
              Not on record?{' '}
              <Link href="/guardians/new" className="font-medium text-foreground underline underline-offset-4">
                Add the guardian
              </Link>{' '}
              first, then link them here.
            </p>
          }
        />
      )}
    </div>
  );
}

/** The API's sentence, with what to do next for the rule refusals of §4. */
function linkErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return describeApiError(error);
  switch (error.code) {
    case ErrorCode.PRIMARY_CONTACT_REQUIRED:
      return `${error.message} Make another guardian the primary contact first.`;
    case ErrorCode.FEE_PAYER_REQUIRED:
      return `${error.message} Mark another guardian as paying fees first.`;
    case ErrorCode.PRIMARY_CONTACT_NEEDS_PHONE:
      return `${error.message} Add a phone number to the guardian’s record first.`;
    default:
      return describeApiError(error);
  }
}

function EditLinkDialog({
  link,
  feePayers,
  onClose,
  onDone,
}: {
  link: GuardianLinkDto | null;
  feePayers: number;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={link !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {link && <EditLinkForm link={link} feePayers={feePayers} onClose={onClose} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function EditLinkForm({
  link,
  feePayers,
  onClose,
  onDone,
}: {
  link: GuardianLinkDto;
  feePayers: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [flags, setFlags] = useState<Flags>({
    relationship: link.relationship,
    isPrimaryContact: link.isPrimaryContact,
    isFeePayer: link.isFeePayer,
    canLogin: link.canLogin,
  });
  const body: UpdateGuardianLinkBody = {
    ...(flags.relationship !== link.relationship && { relationship: flags.relationship as Relationship }),
    ...(flags.isPrimaryContact !== link.isPrimaryContact && { isPrimaryContact: flags.isPrimaryContact }),
    ...(flags.isFeePayer !== link.isFeePayer && { isFeePayer: flags.isFeePayer }),
    ...(flags.canLogin !== link.canLogin && { canLogin: flags.canLogin }),
  };
  const changed = Object.keys(body).length > 0;
  const lastPayer = link.isFeePayer && feePayers <= 1 && !flags.isFeePayer;
  const save = useMutation({
    mutationFn: () =>
      unwrap(studentsApi.PATCH('/api/v1/guardian-links/{id}', { params: { path: { id: link.id } }, body })),
    onSuccess: () => {
      toast.success('Link saved.');
      onDone();
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.GUARDIAN_LINK_ENDED) onDone();
    },
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Edit link: {link.guardianFullName}</DialogTitle>
      </DialogHeader>
      <LinkFlagFields
        value={flags}
        onChange={setFlags}
        hasPhone={link.phone !== null}
        primaryLocked={link.isPrimaryContact}
        disabled={save.isPending}
      />
      {lastPayer && (
        <p className="text-sm text-muted-foreground">
          This is the only guardian paying fees. Mark another guardian as paying first.
        </p>
      )}
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{linkErrorText(save.error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!changed || lastPayer || !flags.relationship || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function EndLinkDialog({
  link,
  feePayers,
  onClose,
  onDone,
}: {
  link: GuardianLinkDto | null;
  feePayers: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const end = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        studentsApi.POST('/api/v1/guardian-links/{id}/end', {
          params: { path: { id: link!.id } },
          body: { reason },
        }),
      ),
    onSuccess: () => {
      toast.success('Link ended.');
      onDone();
      close();
    },
  });
  const close = () => {
    end.reset();
    onClose();
  };
  // R28/R29, shown before the API has to refuse.
  const blocked = link?.isPrimaryContact
    ? 'This guardian is the primary contact. Make another guardian the primary contact first.'
    : link?.isFeePayer && feePayers <= 1
      ? 'This is the only guardian paying fees. Mark another guardian as paying first.'
      : null;

  return (
    <ConfirmWithReasonDialog
      open={link !== null}
      onOpenChange={(open) => !open && close()}
      title={`End link: ${link?.guardianFullName ?? ''}`}
      description="The guardian stays on record and the link is kept in history."
      confirmLabel="End link"
      minLength={3}
      maxLength={500}
      destructive
      pending={end.isPending}
      confirmDisabled={blocked !== null}
      onConfirm={(reason) => end.mutate(reason)}
    >
      {(blocked || end.error) && (
        <Alert variant="destructive">
          <AlertDescription>{blocked ?? linkErrorText(end.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
