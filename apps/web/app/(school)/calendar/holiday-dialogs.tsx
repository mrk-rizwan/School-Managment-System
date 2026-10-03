'use client';

import { Capability, ErrorCode, HOLIDAY_KINDS } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  calendarApi,
  type CreateHolidayBody,
  type HolidayDatesTaken,
  type HolidayDto,
  type UpdateHolidayBody,
} from '@/lib/api/school-calendar-contract';
import { formatDateTime, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import {
  HOLIDAY_KIND_LABELS,
  HolidayStatusBadge,
  addDays,
  calendarKeys,
  holidayDates,
  holidayErrorMessage,
} from './_lib/calendar-ui';

// contracts/slice-10.md §4.3–§4.6 and §13: create and edit (a draft fully; a published holiday's
// description and "staff also off" only), publish, cancel with a reason, and the detail view the
// month and the list open.

export type HolidayAction =
  | { kind: 'create' }
  | { kind: 'detail' | 'edit' | 'publish' | 'cancel'; holiday: HolidayDto };

/** The one place every holiday dialog is opened from. */
export function HolidayDialogs({
  action,
  onAction,
}: {
  action: HolidayAction | null;
  onAction: (action: HolidayAction | null) => void;
}) {
  const close = () => onAction(null);
  return (
    <>
      {(action?.kind === 'create' || action?.kind === 'edit') && (
        <HolidayFormDialog
          key={action.kind === 'edit' ? action.holiday.id : 'new'}
          holiday={action.kind === 'edit' ? action.holiday : undefined}
          onClose={close}
          onOpen={(holiday) => onAction({ kind: 'detail', holiday })}
        />
      )}
      {action?.kind === 'detail' && <HolidayDetailDialog holiday={action.holiday} onAction={onAction} />}
      <PublishHolidayDialog holiday={action?.kind === 'publish' ? action.holiday : null} onClose={close} />
      <CancelHolidayDialog holiday={action?.kind === 'cancel' ? action.holiday : null} onClose={close} />
    </>
  );
}

// ---- Detail ----

function HolidayDetailDialog({ holiday, onAction }: { holiday: HolidayDto; onAction: (a: HolidayAction | null) => void }) {
  const { can } = useCapabilities();
  const canManage = can(Capability.HOLIDAY_MANAGE);
  return (
    <Dialog open onOpenChange={(open) => !open && onAction(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{holiday.name}</DialogTitle>
          <DialogDescription>{holidayDates(holiday)}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Detail label="Status">
            <HolidayStatusBadge status={holiday.status} />
          </Detail>
          <Detail label="Kind">{HOLIDAY_KIND_LABELS[holiday.kind]}</Detail>
          <Detail label="Staff">{holiday.appliesToStaff ? 'Staff are off too' : 'Staff still work'}</Detail>
          {holiday.publishedAt && (
            <Detail label="Published">
              {formatDateTime(holiday.publishedAt)}
              {holiday.publishedByName && ` by ${holiday.publishedByName}`}
            </Detail>
          )}
          {holiday.cancelledAt && (
            <Detail label="Cancelled">
              {formatDateTime(holiday.cancelledAt)}
              {holiday.cancelledByName && ` by ${holiday.cancelledByName}`}
            </Detail>
          )}
          {holiday.description && (
            <div className="grid gap-0.5 sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Description</dt>
              <dd className="whitespace-pre-wrap">{holiday.description}</dd>
            </div>
          )}
          {holiday.cancelReason && (
            <div className="grid gap-0.5 sm:col-span-2">
              <dt className="text-xs text-muted-foreground">Reason for cancelling</dt>
              <dd>{holiday.cancelReason}</dd>
            </div>
          )}
        </dl>
        {canManage && holiday.status !== 'cancelled' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onAction({ kind: 'cancel', holiday })}>
              Cancel holiday
            </Button>
            <Button variant="outline" onClick={() => onAction({ kind: 'edit', holiday })}>
              Edit
            </Button>
            {holiday.status === 'draft' && (
              <Button onClick={() => onAction({ kind: 'publish', holiday })}>Publish</Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// ---- Create and edit (§4.3, §4.4) ----

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const formSchema = z
  .object({
    name: nameSchema(1, 100),
    startsOn: z.string().regex(DATE, 'Enter the first day.'),
    /** Blank: a single day. */
    endsOn: z.string().refine((v) => v === '' || DATE.test(v), 'Enter a date.'),
    kind: z.string().refine((v) => (HOLIDAY_KINDS as readonly string[]).includes(v), 'Choose the kind of holiday.'),
    description: z
      .string()
      .trim()
      .max(500, 'Use at most 500 characters.'),
    appliesToStaff: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!v.endsOn || !DATE.test(v.startsOn)) return;
    if (v.endsOn < v.startsOn) {
      ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'The last day cannot be before the first.' });
    } else if (v.endsOn > addDays(v.startsOn, 365)) {
      ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'A holiday can last at most 366 days.' });
    }
  });
type FormValues = z.infer<typeof formSchema>;

const KIND_OPTIONS = [
  { value: '', label: 'Choose…' },
  ...HOLIDAY_KINDS.map((kind) => ({ value: kind, label: HOLIDAY_KIND_LABELS[kind] })),
];

function HolidayFormDialog({
  holiday,
  onClose,
  onOpen,
}: {
  holiday?: HolidayDto;
  onClose: () => void;
  onOpen: (holiday: HolidayDto) => void;
}) {
  const queryClient = useQueryClient();
  const staffId = useId();
  const descriptionId = useId();
  const published = holiday?.status === 'published';
  // The live holiday a create or edit overlapped (409 HOLIDAY_DATES_TAKEN).
  const [overlap, setOverlap] = useState<HolidayDto | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: holiday?.name ?? '',
      startsOn: holiday?.startsOn ?? '',
      endsOn: holiday && holiday.endsOn !== holiday.startsOn ? holiday.endsOn : '',
      kind: holiday?.kind ?? '',
      description: holiday?.description ?? '',
      appliesToStaff: holiday?.appliesToStaff ?? true,
    },
  });

  const done = (saved: HolidayDto, message: string) => {
    queryClient.setQueryData(calendarKeys.holiday(saved.id), saved);
    void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
    toast.success(message);
    onClose();
  };

  /** The holiday named by HOLIDAY_DATES_TAKEN, read with the ordinary detail route. */
  const readHoliday = (id: string) =>
    queryClient.fetchQuery({
      queryKey: calendarKeys.holiday(id),
      queryFn: () => unwrap(calendarApi.GET('/api/v1/holidays/{id}', { params: { path: { id } } })),
    });

  const save = useMutation({
    mutationFn: (body: CreateHolidayBody | UpdateHolidayBody) =>
      holiday
        ? unwrap(calendarApi.PATCH('/api/v1/holidays/{id}', { params: { path: { id: holiday.id } }, body }))
        : unwrap(calendarApi.POST('/api/v1/holidays', { body: body as CreateHolidayBody })),
    onMutate: () => setOverlap(null),
    onSuccess: (saved) => done(saved, holiday ? 'Holiday saved.' : 'Holiday created as a draft.'),
    onError: async (error, body) => {
      if (error instanceof ApiError && error.code === ErrorCode.HOLIDAY_DATES_TAKEN) {
        const id = (error.details as Partial<HolidayDatesTaken> | null)?.holidayId;
        const other = id ? await readHoliday(id).catch(() => null) : null;
        // §4.3 retry-safety: the same range and name is the create that already succeeded.
        const created = body as CreateHolidayBody;
        if (
          !holiday &&
          other &&
          other.name === created.name &&
          other.startsOn === created.startsOn &&
          other.endsOn === (created.endsOn ?? created.startsOn)
        ) {
          void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
          toast.info('This holiday was already created.');
          onOpen(other);
          return;
        }
        if (other) setOverlap(other);
        else form.setError('root.server', { message: 'These dates overlap another holiday.' });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.HOLIDAY_NOT_DRAFT) {
        void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
      }
      if (!applyApiFieldErrors(form, error)) form.setError('root.server', { message: holidayErrorMessage(error) });
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    const endsOn = v.endsOn || v.startsOn;
    const description = v.description.trim();
    if (!holiday) {
      save.mutate({
        name: v.name,
        startsOn: v.startsOn,
        ...(v.endsOn && { endsOn: v.endsOn }),
        kind: v.kind as CreateHolidayBody['kind'],
        ...(description && { description }),
        appliesToStaff: v.appliesToStaff,
      });
      return;
    }
    // Only what changed is sent; a published holiday never sends its frozen fields.
    const body: UpdateHolidayBody = {
      ...(!published && v.name !== holiday.name && { name: v.name }),
      ...(!published && v.startsOn !== holiday.startsOn && { startsOn: v.startsOn }),
      ...(!published && endsOn !== holiday.endsOn && { endsOn }),
      ...(!published && v.kind !== holiday.kind && { kind: v.kind as CreateHolidayBody['kind'] }),
      ...((description || null) !== holiday.description && { description: description || null }),
      ...(v.appliesToStaff !== holiday.appliesToStaff && { appliesToStaff: v.appliesToStaff }),
    };
    if (Object.keys(body).length === 0) onClose();
    else save.mutate(body);
  });

  const descriptionError = form.formState.errors.description?.message;
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent showCloseButton={!save.isPending}>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{holiday ? `Edit ${holiday.name}` : 'New holiday'}</DialogTitle>
            <DialogDescription>
              {published
                ? 'This holiday is published: only the description and whether staff are off can change. Cancel it and create a new one to change the dates.'
                : 'Saved as a draft. Nobody is told until it is published.'}
            </DialogDescription>
          </DialogHeader>
          <FormRootError form={form} />
          {overlap && (
            <Alert variant="destructive" data-testid="holiday-overlap">
              <AlertDescription>
                <span>
                  Overlaps {overlap.name} ({holidayDates(overlap)}).{' '}
                </span>
                <button
                  type="button"
                  className="font-medium underline underline-offset-4"
                  onClick={() => onOpen(overlap)}
                >
                  Open {overlap.name}
                </button>
              </AlertDescription>
            </Alert>
          )}
          <FormField control={form.control} name="name" label="Name" maxLength={100} disabled={published} />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="startsOn"
              label="First day"
              type="date"
              disabled={published}
            />
            <FormField
              control={form.control}
              name="endsOn"
              label="Last day (optional)"
              type="date"
              hint="Blank for a single day."
              disabled={published}
            />
          </div>
          <FormField control={form.control} name="kind" label="Kind" options={KIND_OPTIONS} disabled={published} />
          <div className="grid gap-1.5">
            <Label htmlFor={descriptionId}>Description (optional)</Label>
            <Textarea
              id={descriptionId}
              rows={3}
              maxLength={500}
              {...form.register('description')}
              aria-invalid={descriptionError ? true : undefined}
            />
            {descriptionError && <p className="text-xs text-destructive">{descriptionError}</p>}
          </div>
          <Controller
            control={form.control}
            name="appliesToStaff"
            render={({ field }) => (
              <div className="flex items-start gap-3">
                <input
                  id={staffId}
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={field.value}
                  onChange={(event) => field.onChange(event.target.checked)}
                  onBlur={field.onBlur}
                  ref={field.ref}
                />
                <div className="grid gap-0.5">
                  <label htmlFor={staffId} className="text-sm font-medium">
                    Staff are off too
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Untick for a day without classes on which staff still work.
                  </p>
                </div>
              </div>
            )}
          />
          {!holiday && (
            <p className="text-xs text-muted-foreground">Past dates are allowed, to record a closure afterwards.</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : holiday ? 'Save changes' : 'Create draft'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Publish (§4.5) ----

function PublishHolidayDialog({ holiday, onClose }: { holiday: HolidayDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const today = todayInSchool();
  const publish = useMutation({
    mutationFn: (id: string) =>
      unwrap(calendarApi.POST('/api/v1/holidays/{id}/publish', { params: { path: { id } } })),
    onSuccess: (saved) => {
      queryClient.setQueryData(calendarKeys.holiday(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
      toast.success(`${saved.name} published.`);
      close();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.ILLEGAL_STATUS_TRANSITION) {
        void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
      }
    },
  });
  const close = () => {
    publish.reset();
    onClose();
  };
  const past = holiday !== null && holiday.endsOn < today;

  return (
    <Dialog open={holiday !== null} onOpenChange={(open) => !open && !publish.isPending && close()}>
      <DialogContent showCloseButton={!publish.isPending}>
        <DialogHeader>
          <DialogTitle>Publish {holiday?.name}</DialogTitle>
          <DialogDescription>{holiday && holidayDates(holiday)}</DialogDescription>
        </DialogHeader>
        <p className="text-sm" data-testid="publish-notice">
          {past
            ? 'No notice is sent for dates already past. Dates cannot be changed after publishing.'
            : 'Every parent and staff member will be told by WhatsApp, SMS or the app. Dates cannot be changed after publishing.'}
        </p>
        {publish.error && (
          <Alert variant="destructive">
            <AlertDescription>{holidayErrorMessage(publish.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={publish.isPending} onClick={close}>
            Not now
          </Button>
          <Button disabled={publish.isPending} onClick={() => holiday && publish.mutate(holiday.id)}>
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Cancel (§4.6) ----

function CancelHolidayDialog({ holiday, onClose }: { holiday: HolidayDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const today = todayInSchool();
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      unwrap(calendarApi.POST('/api/v1/holidays/{id}/cancel', { params: { path: { id } }, body: { reason } })),
    onSuccess: (saved) => {
      queryClient.setQueryData(calendarKeys.holiday(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
      toast.success(`${saved.name} cancelled.`);
      close();
    },
  });
  const close = () => {
    cancel.reset();
    onClose();
  };
  const description =
    holiday?.status === 'published'
      ? holiday.endsOn >= today
        ? 'Everyone who was told will receive a cancellation. The dates become school days again.'
        : 'The dates are already past, so no message is sent. They count as school days again.'
      : 'The draft is withdrawn. Nothing is sent.';

  return (
    <ConfirmWithReasonDialog
      open={holiday !== null}
      onOpenChange={(open) => !open && close()}
      title={`Cancel ${holiday?.name ?? 'holiday'}`}
      description={description}
      confirmLabel="Cancel holiday"
      minLength={3}
      destructive
      pending={cancel.isPending}
      onConfirm={(reason) => holiday && cancel.mutate({ id: holiday.id, reason })}
    >
      {cancel.error && (
        <Alert variant="destructive">
          <AlertDescription>{holidayErrorMessage(cancel.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
