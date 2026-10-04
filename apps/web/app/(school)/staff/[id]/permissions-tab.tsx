'use client';

import { ErrorCode, type Capability, type GrantEffect } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { EmptyState, QueryStates } from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  rolesApi,
  type CapabilitySourceDto,
  type EffectiveCapabilityDto,
  type GrantDto,
  type PermissionRoleDto,
  type UserPermissionsDto,
} from '@/lib/api/school-roles-contract';
import type { StaffDto } from '@/lib/api/school-staff-contract';
import { CAPABILITY_GROUP_LABELS, CAPABILITY_LABELS, GRANTABLE_GROUPS } from '@/lib/capability-labels';
import { formatDateTime } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import {
  CapabilityName,
  PRINCIPAL_PERMISSIONS_NOTE,
  accessErrorMessage,
  accessKeys,
} from '../../custom-roles/_lib/custom-roles-ui';
import { ROLE_LABELS } from '../_lib/staff-ui';

// contracts/slice-7.md §4, §5 and §9: the staff member's permissions in three columns — role
// defaults, this person's grants and revokes, and what is in force. Shown only to role.manage
// holders and never on one's own record (R47, R55); the API refuses both anyway.

const EFFECT_LABELS: Record<GrantEffect, string> = { grant: 'Grant', revoke: 'Revoke' };

export function PermissionsTab({ staff, userId }: { staff: StaffDto; userId: string }) {
  const toggleId = useId();
  const [includeEnded, setIncludeEnded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [ending, setEnding] = useState<GrantDto | null>(null);
  const permissions = useQuery({
    queryKey: [...accessKeys.permissions(userId), { includeEnded }],
    queryFn: () =>
      unwrap(
        rolesApi.GET('/api/v1/users/{id}/permissions', {
          params: { path: { id: userId }, query: { includeEnded } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  return (
    <QueryStates
      query={permissions}
      loadingRows={6}
      noPermission="Only your principal can see and change permissions."
    >
      {(data) => {
        // Principals are unrestricted peers: the API refuses any grant or revoke for one (§4.1).
        const isPrincipal = data.roles.some((r) => r.systemRole === 'principal');
        return (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-sm text-muted-foreground">
                What {staff.fullName} can do: their roles’ defaults, minus what is revoked, plus what
                is granted. Changes count from their next request.
              </p>
              <div className="flex items-center gap-4">
                <div className="flex h-8 items-center gap-2">
                  <input
                    id={toggleId}
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={includeEnded}
                    onChange={(event) => setIncludeEnded(event.target.checked)}
                  />
                  <Label htmlFor={toggleId}>Show ended changes</Label>
                </div>
                {staff.status === 'active' && !isPrincipal && (
                  <Button size="sm" onClick={() => setAddOpen(true)}>
                    Grant or revoke
                  </Button>
                )}
              </div>
            </div>
            {isPrincipal && (
              <Alert>
                <AlertDescription>{PRINCIPAL_PERMISSIONS_NOTE}</AlertDescription>
              </Alert>
            )}
            {!data.staffCapacity && (
              <Alert>
                <AlertDescription>
                  {staff.status === 'active'
                    ? 'This login carries no staff role at present, so nothing is in force.'
                    : 'This staff member is not active, so nothing is in force. Their roles and changes are kept.'}
                </AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 lg:grid-cols-3">
              <Column title="Role defaults" count={data.roles.length}>
                <RolesColumn roles={data.roles} />
              </Column>
              <Column title="Grants and revokes" count={data.deltas.filter((d) => !d.revokedAt).length}>
                <DeltasColumn deltas={data.deltas} onEnd={setEnding} />
              </Column>
              <Column title="In force" count={data.effective.length}>
                <EffectiveColumn data={data} />
              </Column>
            </div>
            <AddDeltaDialog
              staff={staff}
              userId={userId}
              effective={data.effective}
              open={addOpen}
              onOpenChange={setAddOpen}
            />
            <EndDeltaDialog staff={staff} userId={userId} row={ending} onClose={() => setEnding(null)} />
          </div>
        );
      }}
    </QueryStates>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-lg border bg-card">
      <h2 id={id} className="flex items-baseline justify-between border-b px-4 py-3 text-sm font-semibold">
        {title}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
      </h2>
      <div className="grid gap-3 p-4">{children}</div>
    </section>
  );
}

const roleName = (role: PermissionRoleDto) =>
  role.systemRole ? ROLE_LABELS[role.systemRole] : (role.customRoleName ?? 'Custom role');

function RolesColumn({ roles }: { roles: PermissionRoleDto[] }) {
  if (roles.length === 0) {
    return <EmptyState title="No role" description="Give a role on the Login and roles tab." />;
  }
  return (
    <ul className="grid gap-3">
      {roles.map((role) => {
        const archived = role.customRoleStatus === 'archived';
        return (
          <li key={role.userRoleId} className="rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{roleName(role)}</span>
              <Badge variant="outline">{role.systemRole ? 'System role' : 'Custom role'}</Badge>
              {archived && <Badge variant="destructive">Archived</Badge>}
            </div>
            {archived && (
              <p className="mt-1 text-xs text-muted-foreground">An archived role contributes nothing.</p>
            )}
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {role.capabilities.length} {role.capabilities.length === 1 ? 'capability' : 'capabilities'}
              </summary>
              <ul className="mt-2 grid gap-1">
                {role.capabilities.map((c) => (
                  <li key={c}>
                    <CapabilityName capability={c} />
                  </li>
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function DeltasColumn({ deltas, onEnd }: { deltas: GrantDto[]; onEnd: (row: GrantDto) => void }) {
  const { can } = useCapabilities();
  if (deltas.length === 0) {
    return (
      <EmptyState
        title="No grants or revokes"
        description="This person has exactly their roles’ defaults."
      />
    );
  }
  return (
    <ul className="grid gap-3">
      {deltas.map((row) => {
        const ended = row.revokedAt !== null;
        return (
          <li
            key={row.id}
            className="grid gap-1.5 rounded-md border p-3 text-sm"
            aria-label={`${EFFECT_LABELS[row.effect]}: ${CAPABILITY_LABELS[row.capability]}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={row.effect === 'grant' ? 'secondary' : 'destructive'}>
                {EFFECT_LABELS[row.effect]}
              </Badge>
              {ended && <Badge variant="outline">Ended</Badge>}
            </div>
            <CapabilityName capability={row.capability} />
            <p className="text-muted-foreground">“{row.reason}”</p>
            <p className="text-xs text-muted-foreground">
              By {row.grantedByName ?? 'a former user'} · {formatDateTime(row.grantedAt)}
            </p>
            {ended && row.revokedAt && (
              <p className="text-xs text-muted-foreground">
                Ended by {row.revokedByName ?? 'a former user'} · {formatDateTime(row.revokedAt)}
                {row.endReason && <> — “{row.endReason}”</>}
              </p>
            )}
            {!ended &&
              // Ending needs the key too (contract decision 3).
              (can(row.capability) ? (
                <div>
                  <Button variant="outline" size="sm" onClick={() => onEnd(row)}>
                    End
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Only someone who holds this capability can end it.</p>
              ))}
          </li>
        );
      })}
    </ul>
  );
}

function sourceLabel(source: CapabilitySourceDto): string {
  if (source.kind === 'system_role' && source.systemRole) return ROLE_LABELS[source.systemRole];
  if (source.kind === 'custom_role') return source.customRoleName ?? 'Custom role';
  return 'Granted';
}

function EffectiveColumn({ data }: { data: UserPermissionsDto }) {
  if (data.effective.length === 0) {
    return <EmptyState title="Nothing in force" description="This person can do nothing in the school at present." />;
  }
  const groups = new Map<EffectiveCapabilityDto['group'], EffectiveCapabilityDto[]>();
  for (const line of data.effective) groups.set(line.group, [...(groups.get(line.group) ?? []), line]);
  return (
    <div className="grid gap-4">
      {[...groups].map(([group, lines]) => (
        <div key={group} className="grid gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {CAPABILITY_GROUP_LABELS[group]}
          </h3>
          <ul className="grid gap-2">
            {lines.map((line) => (
              <li key={line.capability} className="grid gap-1 text-sm" aria-label={CAPABILITY_LABELS[line.capability]}>
                <CapabilityName capability={line.capability} />
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <Badge variant="outline">
                    {line.scope === 'all' ? 'Whole school' : 'Assigned sections'}
                  </Badge>
                  <span>From {line.sources.map(sourceLabel).join(', ')}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---- Add a grant or revoke (§4.1) ----

function AddDeltaDialog({
  staff,
  userId,
  effective,
  open,
  onOpenChange,
}: {
  staff: StaffDto;
  userId: string;
  /** What is in force now, to warn when a grant would widen a teacher's section scope (N2). */
  effective: EffectiveCapabilityDto[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const ids = { effect: useId(), capability: useId() };
  const [effect, setEffect] = useState<GrantEffect>('grant');
  const [capability, setCapability] = useState<Capability | ''>('');
  // R46: only keys the caller holds; role.manage never (R45).
  const groups = GRANTABLE_GROUPS.map((g) => ({ ...g, capabilities: g.capabilities.filter(can) })).filter(
    (g) => g.capabilities.length > 0,
  );

  const close = () => {
    setEffect('grant');
    setCapability('');
    add.reset();
    onOpenChange(false);
  };
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: accessKeys.permissions(userId) });
    close();
  };
  const add = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        rolesApi.POST('/api/v1/users/{id}/grants', {
          params: { path: { id: userId } },
          body: { capability: capability as Capability, effect, reason },
        }),
      ),
    onSuccess: (row) => {
      toast.success(
        `${row.effect === 'grant' ? 'Granted' : 'Revoked'} “${CAPABILITY_LABELS[row.capability]}” for ${staff.fullName}.`,
      );
      done();
    },
    onError: (error) => {
      // A resubmit after a lost response: the row exists, which is what was wanted (decision 5).
      if (error instanceof ApiError && error.code === ErrorCode.GRANT_EXISTS) {
        toast.info(`${staff.fullName} already has this change in force.`);
        done();
      }
    },
  });
  const shownError = add.error instanceof ApiError && add.error.code === ErrorCode.GRANT_EXISTS ? null : add.error;
  // Security note N2: a grant is school-wide, so it widens a key held only for assigned sections.
  const widensScope =
    effect === 'grant' &&
    effective.some((line) => line.capability === capability && line.scope === 'assigned_sections');

  return (
    <ConfirmWithReasonDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`Grant or revoke for ${staff.fullName}`}
      description="Every change is recorded with your name and reason, and counts from their next request."
      confirmLabel={effect === 'grant' ? 'Grant' : 'Revoke'}
      minLength={3}
      maxLength={500}
      destructive={effect === 'revoke'}
      pending={add.isPending}
      confirmDisabled={capability === ''}
      onConfirm={(reason) => add.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={ids.effect}>Change</Label>
        <NativeSelect
          id={ids.effect}
          value={effect}
          disabled={add.isPending}
          aria-describedby={`${ids.effect}-hint`}
          onChange={(event) => {
            setEffect(event.target.value as GrantEffect);
            add.reset();
          }}
        >
          <option value="grant">Grant — add a capability</option>
          <option value="revoke">Revoke — remove one of their roles’ defaults</option>
        </NativeSelect>
        <p id={`${ids.effect}-hint`} className="text-xs text-muted-foreground">
          {effect === 'grant'
            ? 'A grant is school-wide, whatever their role’s scope.'
            : 'A revoke removes a role default only; it never cancels a grant.'}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={ids.capability}>Capability</Label>
        <NativeSelect
          id={ids.capability}
          value={capability}
          disabled={add.isPending}
          aria-describedby={`${ids.capability}-hint`}
          onChange={(event) => {
            setCapability(event.target.value as Capability | '');
            add.reset();
          }}
        >
          <option value="">Choose…</option>
          {groups.map((g) => (
            <optgroup key={g.group} label={g.label}>
              {g.capabilities.map((c) => (
                <option key={c} value={c}>
                  {CAPABILITY_LABELS[c]}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
        <p id={`${ids.capability}-hint`} className="text-xs text-muted-foreground">
          Only capabilities you hold yourself are listed.
          {/* contracts/slice-13.md §11: there is no read-only diary key. */}
          {capability === 'diary.write' && ' Also lets this user read every section’s diary.'}
        </p>
      </div>
      {widensScope && (
        <Alert>
          <AlertDescription>
            {staff.fullName} already has this for their assigned sections only. A grant gives it to
            them for the whole school.
          </AlertDescription>
        </Alert>
      )}
      {shownError && (
        <Alert variant="destructive">
          <AlertDescription>{accessErrorMessage(shownError)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}

// ---- End a grant or revoke (§4.2) ----

function EndDeltaDialog({
  staff,
  userId,
  row,
  onClose,
}: {
  staff: StaffDto;
  userId: string;
  row: GrantDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const close = () => {
    end.reset();
    onClose();
  };
  const end = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(rolesApi.POST('/api/v1/grants/{id}/end', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      toast.success('Ended.');
      void queryClient.invalidateQueries({ queryKey: accessKeys.permissions(userId) });
      close();
    },
  });
  const label = row ? CAPABILITY_LABELS[row.capability] : '';

  return (
    <ConfirmWithReasonDialog
      open={row !== null}
      onOpenChange={(open) => !open && close()}
      title={row?.effect === 'revoke' ? `End the revoke of “${label}”?` : `End the grant of “${label}”?`}
      description={
        row?.effect === 'revoke'
          ? `${staff.fullName} gets this back if a role of theirs gives it, from their next request.`
          : `${staff.fullName} loses this from their next request, unless a role of theirs gives it.`
      }
      confirmLabel="End"
      minLength={3}
      maxLength={500}
      destructive={row?.effect === 'grant'}
      pending={end.isPending}
      onConfirm={(reason) => row && end.mutate({ id: row.id, reason })}
    >
      {end.error && (
        <Alert variant="destructive">
          <AlertDescription>{accessErrorMessage(end.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
