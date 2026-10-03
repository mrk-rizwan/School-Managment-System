'use client';

import { Capability, ErrorCode, customRoleKeyProblem } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useController, useForm, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import {
  BackLink,
  LoadingState,
  NoPermissionState,
  QueryStates,
  StateCard,
} from '@/components/page-states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  rolesApi,
  type CustomRoleDto,
  type CustomRoleKeyTakenDetails,
  type UpdateCustomRoleBody,
} from '@/lib/api/school-roles-contract';
import { CAPABILITY_LABELS } from '@/lib/capability-labels';
import { formatDateTime } from '@/lib/format';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import {
  CapabilityChecklist,
  CustomRoleStatusBadge,
  accessErrorMessage,
  accessKeys,
} from './_lib/custom-roles-ui';

// contracts/slice-7.md §3.2–§3.5 and §9: create, view, edit and archive one custom role.

const KEY_MESSAGES = {
  format: 'Use 2–32 lower-case letters, digits or underscores, starting with a letter.',
  reserved: 'This key belongs to a system role.',
  identity_number: 'A key cannot contain 13 digits in a row: it may not carry an identity number.',
} as const;

const roleSchema = z.object({
  // One rule with the API (packages/shared customRoleKeyProblem).
  key: z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      const problem = customRoleKeyProblem(v);
      if (problem) ctx.addIssue({ code: 'custom', message: KEY_MESSAGES[problem] });
    }),
  name: nameSchema(2, 100),
  capabilities: z.array(z.enum(Object.values(Capability) as [Capability, ...Capability[]])),
});
type RoleValues = z.input<typeof roleSchema>;

const backLink = <BackLink href="/custom-roles">Custom roles</BackLink>;

const framed = (children: React.ReactNode) => (
  <>
    {backLink}
    <StateCard>{children}</StateCard>
  </>
);

/** `id` absent: the create screen. */
export function CustomRoleEditor({ id }: { id?: string }) {
  const me = useSchoolMe();
  const { can } = useCapabilities();
  const role = useQuery({
    queryKey: accessKeys.customRole(id ?? ''),
    queryFn: () =>
      unwrap(rolesApi.GET('/api/v1/custom-roles/{id}', { params: { path: { id: id ?? '' } } })),
    enabled: id !== undefined,
  });

  if (id === undefined) {
    if (me.isPending) return framed(<LoadingState rows={6} />);
    if (!can(Capability.ROLE_MANAGE)) {
      return framed(<NoPermissionState description="Only your principal creates custom roles." />);
    }
    return (
      <>
        {backLink}
        <PageHeader
          title="New custom role"
          description="Name the role and tick what it allows. You can only tick what you hold yourself."
        />
        <RoleForm />
      </>
    );
  }

  // The checklist reads the caller's capabilities, so wait for /me as well.
  if (me.isPending) return framed(<LoadingState rows={6} />);
  return (
    <>
      {backLink}
      <QueryStates
        query={role}
        loadingRows={6}
        notFound={{ title: 'Custom role not found', description: 'Find it in the custom roles list.' }}
      >
        {(data) => <RoleView role={data} />}
      </QueryStates>
    </>
  );
}
function RoleView({ role }: { role: CustomRoleDto }) {
  const { can } = useCapabilities();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const canWrite = can(Capability.ROLE_MANAGE);
  const archived = role.status === 'archived';

  return (
    <>
      <PageHeader
        title={role.name}
        description={`Key ${role.key} · held by ${role.holderCount === 1 ? '1 person' : `${role.holderCount} people`} · last changed ${formatDateTime(role.updatedAt)}`}
        actions={
          <>
            <CustomRoleStatusBadge status={role.status} />
            {canWrite && !archived && (
              <Button variant="outline" onClick={() => setArchiveOpen(true)}>
                Archive
              </Button>
            )}
          </>
        }
      />
      {archived && (
        <Alert className="mb-6">
          <AlertDescription>
            This role is archived. It gives nothing to anyone and cannot be changed or given again.
          </AlertDescription>
        </Alert>
      )}
      {/* Keyed by the role, not its last update: a refetch must not discard unsaved edits. The
          form resets itself after its own save. */}
      <RoleForm key={role.id} role={role} readOnly={!canWrite || archived} />
      <ArchiveDialog role={role} open={archiveOpen} onOpenChange={setArchiveOpen} />
    </>
  );
}

/** A refusal that is not a field-level 422 goes to the form's root as one sentence. */
function showError(form: UseFormReturn<RoleValues>, error: unknown) {
  if (applyApiFieldErrors(form, error)) return;
  form.setError('root.server', { message: accessErrorMessage(error) });
}

function RoleForm({ role, readOnly = false }: { role?: CustomRoleDto; readOnly?: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  // The role already holding the key, after CUSTOM_ROLE_KEY_TAKEN.
  const [takenBy, setTakenBy] = useState<string | null>(null);
  // An edit that removes keys waits here for its reason (R95).
  const [pendingEdit, setPendingEdit] = useState<UpdateCustomRoleBody | null>(null);
  const form = useForm<RoleValues>({
    resolver: zodResolver(roleSchema),
    defaultValues: { key: role?.key ?? '', name: role?.name ?? '', capabilities: role?.capabilities ?? [] },
    disabled: readOnly,
  });
  const capabilities = useController({ control: form.control, name: 'capabilities' });

  const saved = (updated: CustomRoleDto) => {
    queryClient.setQueryData(accessKeys.customRole(updated.id), updated);
    void queryClient.invalidateQueries({ queryKey: accessKeys.customRoleList });
    // Its holders' permissions views change with its keys.
    void queryClient.invalidateQueries({ queryKey: accessKeys.allPermissions });
  };

  const create = useMutation({
    mutationFn: (values: RoleValues) =>
      unwrap(
        rolesApi.POST('/api/v1/custom-roles', {
          body: { key: values.key.trim(), name: values.name.trim(), capabilities: values.capabilities },
        }),
      ),
    onSuccess: (created) => {
      saved(created);
      toast.success(`${created.name} created.`);
      router.push(`/custom-roles/${created.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.CUSTOM_ROLE_KEY_TAKEN) {
        setTakenBy((error.details as CustomRoleKeyTakenDetails | null)?.customRoleId ?? null);
        form.setError('key', { message: 'An active custom role already uses this key.' }, { shouldFocus: true });
        return;
      }
      showError(form, error);
    },
  });

  const update = useMutation({
    mutationFn: (body: UpdateCustomRoleBody) =>
      unwrap(
        rolesApi.PATCH('/api/v1/custom-roles/{id}', { params: { path: { id: role?.id ?? '' } }, body }),
      ),
    onSuccess: (updated) => {
      setPendingEdit(null);
      saved(updated);
      // The saved values become the form's new starting point.
      form.reset({ key: updated.key, name: updated.name, capabilities: updated.capabilities });
      toast.success(`${updated.name} saved. It counts for its holders from their next request.`);
    },
    onError: (error) => {
      setPendingEdit(null);
      // Archived meanwhile: the refreshed role shows it.
      if (error instanceof ApiError && error.code === ErrorCode.CUSTOM_ROLE_ARCHIVED && role) {
        void queryClient.invalidateQueries({ queryKey: accessKeys.customRole(role.id) });
      }
      showError(form, error);
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setTakenBy(null);
    if (!role) {
      create.mutate(values);
      return;
    }
    const before = new Set(role.capabilities);
    const after = new Set(values.capabilities);
    const changedSet =
      before.size !== after.size || role.capabilities.some((c) => !after.has(c));
    const body: UpdateCustomRoleBody = {
      ...(values.name.trim() !== role.name && { name: values.name.trim() }),
      ...(changedSet && { capabilities: values.capabilities }),
    };
    if (Object.keys(body).length === 0) return;
    if (role.capabilities.some((c) => !after.has(c))) setPendingEdit(body);
    else update.mutate(body);
  });

  const pending = create.isPending || update.isPending;
  const removed = role && pendingEdit ? role.capabilities.filter((c) => !pendingEdit.capabilities?.includes(c)) : [];
  const count = capabilities.field.value.length;

  return (
    <>
      <form noValidate onSubmit={onSubmit} className="grid gap-6">
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Role</CardTitle>
            {readOnly && role?.status === 'active' && (
              <CardDescription>You can view this role but not change it.</CardDescription>
            )}
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormRootError form={form} />
            {role ? (
              <div className="grid gap-1.5">
                <p className="text-sm font-medium">Key</p>
                <p className="font-mono text-sm text-muted-foreground">{role.key}</p>
              </div>
            ) : (
              <FormField
                control={form.control}
                name="key"
                label="Key"
                hint="A short code for the role, e.g. accounts_clerk. It cannot be changed later."
                autoComplete="off"
                maxLength={32}
              />
            )}
            {takenBy && (
              <p className="-mt-2 text-sm">
                <Link href={`/custom-roles/${takenBy}`} className="font-medium underline underline-offset-4">
                  Open the role using this key
                </Link>
              </p>
            )}
            <FormField control={form.control} name="name" label="Name" maxLength={100} />
          </CardContent>
        </Card>

        <section className="grid gap-3" aria-labelledby="capabilities-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="capabilities-heading" className="text-base font-semibold">
              Capabilities
            </h2>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {count} selected. Managing roles is never part of a custom role.
            </p>
          </div>
          <CapabilityChecklist
            value={capabilities.field.value}
            onChange={capabilities.field.onChange}
            held={can}
            existing={role?.capabilities}
            disabled={readOnly || pending}
          />
        </section>

        {!readOnly && (
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || (role !== undefined && !form.formState.isDirty)}>
              {pending ? 'Saving…' : role ? 'Save changes' : 'Create role'}
            </Button>
            {role && (
              <Button
                type="button"
                variant="outline"
                disabled={pending || !form.formState.isDirty}
                onClick={() => form.reset()}
              >
                Discard
              </Button>
            )}
          </div>
        )}
      </form>

      {/* Outside the form: React events bubble through portals, so a nested submit would reach it. */}
      <ConfirmWithReasonDialog
        open={pendingEdit !== null}
        onOpenChange={(open) => !open && setPendingEdit(null)}
        title="Remove capabilities from this role?"
        description={`They stop counting for ${role?.holderCount === 1 ? 'its 1 holder' : `its ${role?.holderCount ?? 0} holders`} from their next request.`}
        confirmLabel="Save and remove"
        minLength={3}
        maxLength={500}
        destructive
        pending={update.isPending}
        onConfirm={(reason) => pendingEdit && update.mutate({ ...pendingEdit, reason })}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm" aria-label="Capabilities removed">
          {removed.map((c) => (
            <li key={c}>{CAPABILITY_LABELS[c]}</li>
          ))}
        </ul>
      </ConfirmWithReasonDialog>
    </>
  );
}

function ArchiveDialog({
  role,
  open,
  onOpenChange,
}: {
  role: CustomRoleDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        rolesApi.POST('/api/v1/custom-roles/{id}/archive', { params: { path: { id: role.id } }, body: { reason } }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(accessKeys.customRole(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: accessKeys.customRoleList });
      void queryClient.invalidateQueries({ queryKey: accessKeys.allPermissions });
      toast.success(`${updated.name} archived.`);
      close();
    },
    onError: (error) => {
      // The refreshed role shows its current holder count.
      if (error instanceof ApiError && error.code === ErrorCode.CUSTOM_ROLE_IN_USE) {
        void queryClient.invalidateQueries({ queryKey: accessKeys.customRole(role.id) });
      }
    },
  });
  const close = () => {
    archive.reset();
    onOpenChange(false);
  };

  return (
    <ConfirmWithReasonDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={`Archive ${role.name}?`}
      description="An archived role gives nothing and cannot be given again. Its key becomes free for a new role. There is no undo."
      confirmLabel="Archive role"
      minLength={3}
      maxLength={500}
      destructive
      pending={archive.isPending}
      onConfirm={(reason) => archive.mutate(reason)}
    >
      {role.holderCount > 0 && !archive.error && (
        <Alert>
          <AlertDescription>
            {role.holderCount === 1 ? '1 person holds' : `${role.holderCount} people hold`} this role. A
            role can only be archived once nobody holds it.
          </AlertDescription>
        </Alert>
      )}
      {archive.error && (
        <Alert variant="destructive">
          <AlertDescription>{accessErrorMessage(archive.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
