'use client';

import { Capability, DEFAULT_TIMEZONE, ErrorCode, SYSTEM_ROLES } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  staffApi,
  type StaffDto,
  type SystemRole,
  type UserRoleDto,
} from '@/lib/api/school-staff-contract';
import { useCapabilities } from '../../academics/_lib/hooks';
import { ROLE_LABELS, givableRoles, staffErrorMessage, staffKeys } from '../_lib/staff-ui';

/** contracts/slice-4.md §3.6, §5 and §8: the login card and the roles table. */
export function LoginAndRolesTab({ staff, isSelf }: { staff: StaffDto; isSelf: boolean }) {
  const { can } = useCapabilities();
  const canSeeRoles = can(Capability.USER_ACCOUNT_MANAGE) || can(Capability.ROLE_MANAGE);
  return (
    <div className="grid gap-6">
      <LoginCard staff={staff} />
      {staff.userId && canSeeRoles && <RolesSection staff={staff} userId={staff.userId} isSelf={isSelf} />}
    </div>
  );
}

// ---- Login (§3.6) ----

function LoginCard({ staff }: { staff: StaffDto }) {
  const { can } = useCapabilities();
  const [open, setOpen] = useState(false);
  const roles = givableRoles(can);
  const canIssue =
    can(Capability.USER_ACCOUNT_MANAGE) &&
    staff.userId === null &&
    staff.status === 'active' &&
    staff.hasCnic &&
    roles.length > 0;

  // The preconditions of §3.6, in the order the API checks them.
  let text: string;
  if (staff.userId) {
    text =
      staff.systemRoles.length > 0
        ? `Has a login, as ${staff.systemRoles.map((r) => ROLE_LABELS[r]).join(', ')}.`
        : 'Has a login, with no staff role at present.';
  } else if (staff.status !== 'active') text = 'Only an active staff member can be given a login.';
  else if (!staff.hasCnic) text = 'Record the CNIC on the Details tab to issue a login: it is the username.';
  else if (can(Capability.USER_ACCOUNT_MANAGE) && roles.length === 0) {
    text = 'No login yet. You cannot give any staff role, so ask your principal to issue it.';
  } else text = 'No login yet.';

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Login</CardTitle>
        <CardDescription>{text}</CardDescription>
      </CardHeader>
      {canIssue && (
        <CardContent>
          <Button onClick={() => setOpen(true)}>Issue login</Button>
          <IssueLoginDialog staff={staff} roles={roles} open={open} onOpenChange={setOpen} />
        </CardContent>
      )}
    </Card>
  );
}

function IssueLoginDialog({
  staff,
  roles,
  open,
  onOpenChange,
}: {
  staff: StaffDto;
  roles: SystemRole[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={!pending}>
        {/* Unmounts on close, so every opening starts from the first step. */}
        <IssueLoginForm
          staff={staff}
          roles={roles}
          onPendingChange={setPending}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function IssueLoginForm({
  staff,
  roles,
  onPendingChange,
  onDone,
}: {
  staff: StaffDto;
  roles: SystemRole[];
  onPendingChange: (pending: boolean) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const selectId = useId();
  const [role, setRole] = useState<SystemRole | ''>(roles.length === 1 ? roles[0] : '');
  // Set when the CNIC already has a sign-in (§3.6, LINK_EXISTING_LOGIN_UNCONFIRMED): the second
  // step asks before that sign-in is reset and linked.
  const [confirmLink, setConfirmLink] = useState(false);

  const issue = useMutation({
    mutationFn: (confirmLinkExisting: boolean) =>
      unwrap(
        staffApi.POST('/api/v1/staff/{id}/issue-login', {
          params: { path: { id: staff.id } },
          body: { systemRole: role as SystemRole, ...(confirmLinkExisting && { confirmLinkExisting }) },
        }),
      ),
    onMutate: () => onPendingChange(true),
    onSettled: () => {
      onPendingChange(false);
      void queryClient.invalidateQueries({ queryKey: staffKeys.all });
    },
    onSuccess: (_user, linked) => {
      toast.success(
        linked
          ? `${staff.fullName}’s existing sign-in now carries the ${ROLE_LABELS[role as SystemRole].toLowerCase()} role.`
          : `Login issued to ${staff.fullName}.`,
      );
      onDone();
    },
    onError: (error, linked) => {
      if (!(error instanceof ApiError)) return;
      // A resubmit after a lost response: the login exists, which is what was wanted (§3.6).
      if (error.code === ErrorCode.LOGIN_ALREADY_EXISTS) {
        toast.info(`${staff.fullName} already has a login.`);
        onDone();
        return;
      }
      if (error.code === ErrorCode.LINK_EXISTING_LOGIN_UNCONFIRMED && !linked) setConfirmLink(true);
    },
  });
  const shownError =
    issue.error instanceof ApiError && issue.error.code === ErrorCode.LINK_EXISTING_LOGIN_UNCONFIRMED
      ? null
      : issue.error;

  if (confirmLink) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>This CNIC already has a sign-in</DialogTitle>
          <DialogDescription>
            {staff.fullName} already signs in to this school, for example as a parent.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm">
          <p>Linking that sign-in to this staff record will:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>reset its password to the default, their CNIC digits;</li>
            <li>clear its email address;</li>
            <li>sign them out everywhere.</li>
          </ul>
          <p>They keep one sign-in, now with the {ROLE_LABELS[role as SystemRole].toLowerCase()} role as well.</p>
        </div>
        {shownError && (
          <Alert variant="destructive">
            <AlertDescription>{staffErrorMessage(shownError)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={issue.isPending}
            onClick={() => {
              issue.reset();
              setConfirmLink(false);
            }}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={issue.isPending}
            onClick={() => issue.mutate(true)}
          >
            {issue.isPending ? 'Working…' : 'Reset and link login'}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (role && !issue.isPending) issue.mutate(false);
      }}
    >
      <DialogHeader>
        <DialogTitle>Issue a login to {staff.fullName}?</DialogTitle>
        <DialogDescription>
          The username is their CNIC without dashes. The password is the same CNIC until they
          change it. Tell them in person; nothing is sent to them.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={selectId}>Role</Label>
        <NativeSelect
          id={selectId}
          value={role}
          disabled={issue.isPending}
          onChange={(event) => setRole(event.target.value as SystemRole | '')}
          aria-describedby={`${selectId}-hint`}
        >
          <option value="">Choose…</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
        <p id={`${selectId}-hint`} className="text-xs text-muted-foreground">
          Only the roles you may give are listed.
        </p>
      </div>
      {shownError && (
        <Alert variant="destructive">
          <AlertDescription>{staffErrorMessage(shownError)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={issue.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!role || issue.isPending}>
          {issue.isPending ? 'Issuing…' : 'Issue login'}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- Roles (§5) ----

const ROLES_LIMIT = 25;
const NO_ROLES: UserRoleDto[] = [];
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: DEFAULT_TIMEZONE,
});
const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

function RolesSection({ staff, userId, isSelf }: { staff: StaffDto; userId: string; isSelf: boolean }) {
  const { can } = useCapabilities();
  // Write controls only with role.manage (§8), never on one's own login (R74), and a role can
  // only be given to an active staff member (§5.2).
  const canWrite = can(Capability.ROLE_MANAGE) && !isSelf;
  const toggleId = useId();
  const [page, setPage] = useState(1);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [removing, setRemoving] = useState<UserRoleDto | null>(null);

  const query = { page, limit: ROLES_LIMIT, includeEnded, sort: '-assignedAt' } as const;
  const roles = useQuery({
    queryKey: [...staffKeys.roles(userId), query],
    queryFn: () =>
      unwrap(staffApi.GET('/api/v1/users/{id}/roles', { params: { path: { id: userId }, query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, UserRoleDto>();
    return [
      column.accessor('systemRole', {
        header: 'Role',
        cell: (info) => {
          const role = info.getValue();
          return <span className="font-medium">{role ? ROLE_LABELS[role] : 'Custom role'}</span>;
        },
      }),
      column.accessor('assignedAt', {
        header: 'Given',
        cell: (info) => (
          <span>
            {formatDateTime(info.getValue())}
            {info.row.original.assignedBy === null && (
              <span className="text-muted-foreground"> · by the platform</span>
            )}
          </span>
        ),
      }),
      column.accessor('endedAt', {
        header: 'Status',
        cell: (info) => {
          const ended = info.getValue();
          return ended ? (
            <span className="text-muted-foreground">Ended {formatDateTime(ended)}</span>
          ) : (
            <Badge variant="secondary">Current</Badge>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const row = info.row.original;
          if (!canWrite || row.endedAt) return null;
          return (
            <Button variant="outline" size="sm" onClick={() => setRemoving(row)}>
              Remove
            </Button>
          );
        },
      }),
    ];
  }, [canWrite]);

  const result = roles.data;
  return (
    <section className="grid gap-3" aria-labelledby={`${toggleId}-heading`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${toggleId}-heading`} className="text-base font-semibold">
          Roles
        </h2>
        <div className="flex items-center gap-4">
          <div className="flex h-8 items-center gap-2">
            <input
              id={toggleId}
              type="checkbox"
              className="size-4 accent-primary"
              checked={includeEnded}
              onChange={(event) => {
                setIncludeEnded(event.target.checked);
                setPage(1);
              }}
            />
            <Label htmlFor={toggleId}>Show history</Label>
          </div>
          {canWrite && staff.status === 'active' && (
            <Button size="sm" onClick={() => setAssignOpen(true)}>
              Give a role
            </Button>
          )}
        </div>
      </div>
      <DataTable
        columns={columns}
        data={result?.data ?? NO_ROLES}
        getRowId={(row) => row.id}
        page={result?.page ?? page}
        limit={result?.limit ?? ROLES_LIMIT}
        total={result?.total ?? 0}
        onPageChange={setPage}
        isLoading={roles.isPending || roles.isPlaceholderData}
        error={roles.error}
        onRetry={() => void roles.refetch()}
        emptyTitle={includeEnded ? 'No roles yet' : 'No current role'}
        emptyDescription={
          canWrite && staff.status === 'active'
            ? 'This login works only once it carries a role. Give one above.'
            : 'This login carries no staff role at present.'
        }
      />
      <AssignRoleDialog
        staff={staff}
        userId={userId}
        open={assignOpen}
        onOpenChange={setAssignOpen}
      />
      <RemoveRoleDialog staff={staff} userId={userId} row={removing} onClose={() => setRemoving(null)} />
    </section>
  );
}

function AssignRoleDialog({
  staff,
  userId,
  open,
  onOpenChange,
}: {
  staff: StaffDto;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const selectId = useId();
  // Roles the login does not already hold live (§5.2 ROLE_ALREADY_ASSIGNED otherwise).
  const options = SYSTEM_ROLES.filter(
    (r) => !staff.systemRoles.includes(r),
  );
  const [role, setRole] = useState<SystemRole | ''>('');
  const close = () => {
    setRole('');
    assign.reset();
    onOpenChange(false);
  };
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: staffKeys.all });
    close();
  };
  const assign = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        staffApi.POST('/api/v1/users/{id}/roles', {
          params: { path: { id: userId } },
          body: { systemRole: role as SystemRole, reason },
        }),
      ),
    onSuccess: (row) => {
      toast.success(`${staff.fullName} is now ${row.systemRole ? ROLE_LABELS[row.systemRole].toLowerCase() : 'given the role'}.`);
      done();
    },
    onError: (error) => {
      // A resubmit after a lost response: the role is held, which is what was wanted.
      if (error instanceof ApiError && error.code === ErrorCode.ROLE_ALREADY_ASSIGNED) {
        toast.info(`${staff.fullName} already holds this role.`);
        done();
      }
    },
  });

  return (
    <ConfirmWithReasonDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`Give a role to ${staff.fullName}`}
      description="The role counts from their next request. Every role change is recorded with its reason."
      confirmLabel="Give role"
      minLength={3}
      maxLength={500}
      pending={assign.isPending}
      confirmDisabled={role === ''}
      onConfirm={(reason) => assign.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={selectId}>Role</Label>
        <NativeSelect
          id={selectId}
          value={role}
          disabled={assign.isPending}
          onChange={(event) => {
            setRole(event.target.value as SystemRole | '');
            assign.reset();
          }}
        >
          <option value="">Choose…</option>
          {options.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {role === 'principal' && (
        <p className="text-sm text-muted-foreground">
          A principal can do everything in the school, including managing roles.
        </p>
      )}
      {assign.error && !(assign.error instanceof ApiError && assign.error.code === ErrorCode.ROLE_ALREADY_ASSIGNED) && (
        <Alert variant="destructive">
          <AlertDescription>{staffErrorMessage(assign.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}

function RemoveRoleDialog({
  staff,
  userId,
  row,
  onClose,
}: {
  staff: StaffDto;
  userId: string;
  row: UserRoleDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const close = () => {
    remove.reset();
    onClose();
  };
  const remove = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(staffApi.POST('/api/v1/user-roles/{id}/remove', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      toast.success('Role removed.');
      void queryClient.invalidateQueries({ queryKey: staffKeys.all });
      void queryClient.invalidateQueries({ queryKey: staffKeys.roles(userId) });
      close();
    },
  });
  const label = row?.systemRole ? ROLE_LABELS[row.systemRole] : 'Custom role';

  return (
    <ConfirmWithReasonDialog
      open={row !== null}
      onOpenChange={(open) => !open && close()}
      title={`Remove ${label.toLowerCase()} from ${staff.fullName}?`}
      description="It stops counting from their next request. Their login stays; with no role left it can no longer be used for staff work."
      confirmLabel="Remove role"
      minLength={3}
      maxLength={500}
      destructive
      pending={remove.isPending}
      onConfirm={(reason) => row && remove.mutate({ id: row.id, reason })}
    >
      {remove.error && (
        <Alert variant="destructive">
          <AlertDescription>{staffErrorMessage(remove.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
