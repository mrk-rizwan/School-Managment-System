'use client';

import { Capability, ErrorCode, normaliseIdentityDigits } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoPermissionState,
  isPermissionDenied,
} from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  staffApi,
  type StaffDto,
  type StaffStatus,
  type UpdateStaffBody,
} from '@/lib/api/school-staff-contract';
import { useSchoolMe } from '@/lib/school-session';
import { cn } from '@/lib/utils';
import { useCapabilities } from '../../academics/_lib/hooks';
import { blankToNull, formatIdentityInput } from '../../guardians/_lib/guardians-ui';
import {
  STAFF_STATUS_LABELS,
  StaffMoreFields,
  StaffStatusBadge,
  staffErrorMessage,
  staffFieldsSchema,
  staffKeys,
  type StaffFieldValues,
} from '../_lib/staff-ui';
import { AssignmentsTab } from './assignments-tab';
import { LoginAndRolesTab } from './roles-tab';

type Tab = 'details' | 'roles' | 'assignments';

/** contracts/slice-4.md §3.2, §3.4, §3.5 and §8. */
export function StaffDetail({ id }: { id: string }) {
  const { can } = useCapabilities();
  const me = useSchoolMe();
  const [tab, setTab] = useState<Tab>('details');
  const [statusOpen, setStatusOpen] = useState(false);
  const staff = useQuery({
    queryKey: staffKeys.detail(id),
    queryFn: () => unwrap(staffApi.GET('/api/v1/staff/{id}', { params: { path: { id } } })),
  });

  const back = (
    <Link
      href="/staff"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" />
      Staff
    </Link>
  );
  const frame = (children: React.ReactNode) => (
    <>
      {back}
      <div className="rounded-lg border bg-card">{children}</div>
    </>
  );

  if (staff.isPending) return frame(<LoadingState rows={5} />);
  if (staff.error) {
    if (isPermissionDenied(staff.error)) return frame(<NoPermissionState />);
    const notFound = staff.error instanceof ApiError && staff.error.status === 404;
    return frame(
      notFound ? (
        <EmptyState title="Staff member not found" description="Find them in the staff list." />
      ) : (
        <ErrorState error={staff.error} onRetry={() => void staff.refetch()} />
      ),
    );
  }

  const data = staff.data;
  // R74: nobody changes their own status or roles; the controls are hidden on one's own record.
  const isSelf = data.userId !== null && data.userId === me.data?.id;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'details', label: 'Details' },
    { id: 'roles', label: 'Login and roles' },
    // GET …/teacher-assignments needs class.manage (§1).
    ...(can(Capability.CLASS_MANAGE) ? [{ id: 'assignments' as const, label: 'Teaching assignments' }] : []),
  ];

  return (
    <>
      {back}
      <PageHeader
        title={data.fullName}
        description={data.designation ?? 'Staff member'}
        actions={
          <>
            <StaffStatusBadge status={data.status} />
            {can(Capability.STAFF_STATUS_CHANGE) && !isSelf && (
              <Button variant="outline" onClick={() => setStatusOpen(true)}>
                Change status
              </Button>
            )}
          </>
        }
      />
      {isSelf && (
        <Alert className="mb-6">
          <AlertDescription>
            This is your own record. Another member of staff changes your status and roles.
          </AlertDescription>
        </Alert>
      )}
      <div role="tablist" aria-label="Staff member" className="mb-6 flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`staff-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`staff-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              tab === t.id
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`staff-panel-${tab}`} aria-labelledby={`staff-tab-${tab}`}>
        {/* Keyed by the last update so the form restarts from the saved values. */}
        {tab === 'details' && <EditStaffForm key={data.updatedAt} staff={data} />}
        {tab === 'roles' && <LoginAndRolesTab staff={data} isSelf={isSelf} />}
        {tab === 'assignments' && <AssignmentsTab staff={data} />}
      </div>
      <ChangeStatusDialog staff={data} open={statusOpen} onOpenChange={setStatusOpen} />
    </>
  );
}

// ---- Details (§3.4) ----

function EditStaffForm({ staff }: { staff: StaffDto }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const readOnly = !can(Capability.STAFF_UPDATE);
  // The CNIC is the login username, so it is locked once a login exists (§3.4, R24).
  const cnicLocked = staff.userId !== null;
  const [existingId, setExistingId] = useState<string | null>(null);
  const form = useForm<StaffFieldValues>({
    resolver: zodResolver(staffFieldsSchema),
    defaultValues: {
      fullName: staff.fullName,
      cnic: '',
      phone: staff.phone,
      designation: staff.designation ?? '',
      joinedOn: staff.joinedOn ?? '',
    },
    disabled: readOnly,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: staffKeys.all });
  const save = useMutation({
    mutationFn: (body: UpdateStaffBody) =>
      unwrap(staffApi.PATCH('/api/v1/staff/{id}', { params: { path: { id: staff.id } }, body })),
    onSuccess: (updated) => {
      queryClient.setQueryData(staffKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: staffKeys.list });
      toast.success('Staff member saved.');
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : null;
      if (code === ErrorCode.STAFF_CNIC_EXISTS) {
        const id = ((error as ApiError).details as { staffId?: unknown } | null)?.staffId;
        setExistingId(typeof id === 'string' ? id : null);
        form.setError('cnic', { message: (error as ApiError).message }, { shouldFocus: true });
        return;
      }
      if (code === ErrorCode.STAFF_CNIC_LOCKED) {
        // A login was issued meanwhile: the refreshed record shows the CNIC as locked.
        toast.error((error as ApiError).message);
        refresh();
        return;
      }
      if (code === ErrorCode.CONCURRENT_UPDATE) refresh();
      applyApiError(form, error);
    },
  });

  // Only what changed is sent; blank optional fields clear (null).
  const onSubmit = form.handleSubmit((values) => {
    setExistingId(null);
    const designation = blankToNull(values.designation);
    const joinedOn = values.joinedOn || null;
    const body: UpdateStaffBody = {
      ...(values.fullName.trim() !== staff.fullName && { fullName: values.fullName.trim() }),
      ...(!cnicLocked && values.cnic.trim() && { cnic: normaliseIdentityDigits(values.cnic) }),
      ...(values.phone.trim() !== staff.phone && { phone: values.phone.trim() }),
      ...(designation !== staff.designation && { designation }),
      ...(joinedOn !== staff.joinedOn && { joinedOn }),
    };
    if (Object.keys(body).length > 0) save.mutate(body);
  });

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Details</CardTitle>
        {readOnly && <CardDescription>You can view this record but not change it.</CardDescription>}
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField control={form.control} name="fullName" label="Full name" maxLength={200} />
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">CNIC</p>
            <p className="font-mono text-sm text-muted-foreground">{staff.cnicMasked ?? 'Not recorded'}</p>
            {cnicLocked && (
              <p className="text-xs text-muted-foreground">
                This staff member has a login and the CNIC is its username, so it cannot be changed
                here.
              </p>
            )}
          </div>
          {!cnicLocked && !readOnly && (
            <FormField
              control={form.control}
              name="cnic"
              label={staff.hasCnic ? 'Replace CNIC (optional)' : 'Add CNIC (optional)'}
              hint="Leave blank to keep the current value."
              inputMode="numeric"
              autoComplete="off"
              placeholder="35201-1234567-1"
              maxLength={15}
              format={formatIdentityInput}
            />
          )}
          {existingId && (
            <p className="-mt-2 text-sm">
              <Link href={`/staff/${existingId}`} className="font-medium underline underline-offset-4">
                Open existing staff member
              </Link>{' '}
              <span className="text-muted-foreground">— the record with this CNIC.</span>
            </p>
          )}
          <StaffMoreFields control={form.control} disabled={readOnly} />
          {!readOnly && (
            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={save.isPending || !form.formState.isDirty}
                onClick={() => form.reset()}
              >
                Discard
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ---- Status (§3.5) ----

/** Legal moves (§3.5): `left → suspended` is refused. */
const NEXT_STATUSES: Record<StaffStatus, StaffStatus[]> = {
  active: ['suspended', 'left'],
  suspended: ['active', 'left'],
  left: ['active'],
};

/** What each move does, in the office's words (§3.5 effects, R17–R19, R70). */
function consequences(from: StaffStatus, to: StaffStatus, hasLogin: boolean): string[] {
  if (to === 'left') {
    return [
      ...(hasLogin
        ? [
            'Every role on their login is ended.',
            'They are signed out everywhere at once.',
          ]
        : []),
      'Every teaching assignment is ended.',
      'Re-hiring later restores nothing: roles and assignments must be given again.',
    ];
  }
  if (to === 'suspended') {
    return [
      ...(hasLogin ? ['They are signed out everywhere and cannot work as staff while suspended.'] : []),
      'Roles and teaching assignments are kept, and count again when they are made active.',
    ];
  }
  if (from === 'left') {
    return [
      'This is a re-hire. Nothing is restored.',
      'Give them a role and add their teaching assignments again.',
    ];
  }
  return ['Their roles and teaching assignments count again.'];
}

function ChangeStatusDialog({
  staff,
  open,
  onOpenChange,
}: {
  staff: StaffDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const selectId = useId();
  const options = NEXT_STATUSES[staff.status];
  const [target, setTarget] = useState<StaffStatus | ''>('');
  const change = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        staffApi.POST('/api/v1/staff/{id}/change-status', {
          params: { path: { id: staff.id } },
          body: { status: target as StaffStatus, reason },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(staffKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: staffKeys.all });
      toast.success(`${updated.fullName}: status changed to ${STAFF_STATUS_LABELS[updated.status]}.`);
      close();
    },
    onError: (error) => {
      // The record changed meanwhile: show its current state behind the dialog.
      if (error instanceof ApiError && error.code === ErrorCode.ILLEGAL_STATUS_TRANSITION) {
        void queryClient.invalidateQueries({ queryKey: staffKeys.detail(staff.id) });
      }
    },
  });
  const close = () => {
    setTarget('');
    change.reset();
    onOpenChange(false);
  };

  return (
    <ConfirmWithReasonDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`Change status: ${staff.fullName}`}
      description={`Currently ${STAFF_STATUS_LABELS[staff.status].toLowerCase()}.`}
      confirmLabel={target ? `Mark as ${STAFF_STATUS_LABELS[target].toLowerCase()}` : 'Change status'}
      minLength={3}
      maxLength={500}
      destructive={target === 'left' || target === 'suspended'}
      pending={change.isPending}
      confirmDisabled={target === ''}
      onConfirm={(reason) => change.mutate(reason)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={selectId}>New status</Label>
        <NativeSelect
          id={selectId}
          value={target}
          disabled={change.isPending}
          onChange={(event) => {
            setTarget(event.target.value as StaffStatus | '');
            change.reset();
          }}
        >
          <option value="">Choose…</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {STAFF_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {target && (
        <ul className="list-disc space-y-1 pl-5 text-sm" aria-label="What this does">
          {consequences(staff.status, target, staff.userId !== null).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {change.error && (
        <Alert variant="destructive">
          <AlertDescription>{staffErrorMessage(change.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
