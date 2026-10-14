'use client';

import {
  Capability,
  ErrorCode,
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  containsIdentityNumber,
  newIdempotencyKey,
  todayInSchool,
  type EventType,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { CheckboxField } from '@/components/checkbox-field';
import { FormField, FormRootError } from '@/components/form-field';
import { BackLink, NoPermissionState, StateCard } from '@/components/page-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { eventsApi, type CreateEventBody, type EventDto, type UpdateEventBody } from '@/lib/api/school-events-contract';
import { useCapabilities } from '@/lib/school-session';
import { useYearSections, useYears } from '../academics/_lib/options';
import { instantToLocal } from '../announcements/_lib/announcements-ui';
import { digitsOnly, rupeesSchema } from '../fees/_lib/fees-ui';
import { eventErrorMessage, eventHref, eventKeys } from './_lib/events-ui';

// contracts/slice-38.md §2.1, §2.2, §6: the draft form. Times are typed in school time (Karachi,
// +05:00) and sent as instants. Create carries one Idempotency-Key per opening of the form; edit is
// a PATCH of the fields that changed, draft only. The charge needs charge.create and
// charge.campaign.send, so it is offered only to a holder of both.

const TITLE_MAX = 120;
const VENUE_MAX = 120;
const DETAILS_MAX = 1000;
const noId = (v: string) => !containsIdentityNumber(v.replace(/[\s+-]/g, ''));
const TIME = /^\d{2}:\d{2}$/;

const schema = z
  .object({
    academicYearId: z.string().min(1, 'Choose the academic year.'),
    type: z.enum(EVENT_TYPES),
    title: z
      .string()
      .trim()
      .min(1, 'Give the event a title.')
      .max(TITLE_MAX, `Use at most ${TITLE_MAX} characters.`)
      .refine(noId, 'Remove the identity number.'),
    startDate: z.string().min(1, 'Choose the date.'),
    startTime: z.string().regex(TIME, 'Choose the start time.'),
    endDate: z.string(),
    endTime: z.string().regex(TIME, 'Choose the end time.'),
    venue: z
      .string()
      .trim()
      .min(1, 'Say where it happens.')
      .max(VENUE_MAX, `Use at most ${VENUE_MAX} characters.`)
      .refine(noId, 'Remove the identity number.'),
    details: z.string().trim().max(DETAILS_MAX, `Use at most ${DETAILS_MAX} characters.`).refine(noId, 'Remove the identity number.'),
    sectionIds: z.array(z.string()),
    hasCharge: z.boolean(),
    amount: z.string(),
    dueOn: z.string(),
  })
  .superRefine((v, ctx) => {
    const end = `${v.endDate || v.startDate}T${v.endTime}`;
    if (v.startDate && TIME.test(v.startTime) && TIME.test(v.endTime) && end < `${v.startDate}T${v.startTime}`) {
      ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Cannot end before it starts.' });
    }
    if (v.hasCharge) {
      const amount = rupeesSchema.safeParse(v.amount);
      if (!amount.success || Number(v.amount) < 1) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: amount.success ? 'Enter at least Rs 1.' : amount.error.issues[0]!.message });
      }
      if (v.dueOn && v.dueOn < todayInSchool()) {
        ctx.addIssue({ code: 'custom', path: ['dueOn'], message: 'The due date cannot be in the past.' });
      }
    }
  });
type Values = z.infer<typeof schema>;

const TYPE_OPTIONS = EVENT_TYPES.map((t) => ({ value: t, label: EVENT_TYPE_LABELS[t] }));

/** The API's field paths, on this form's fields. */
const FIELD_OF: Record<string, FieldPath<Values>> = {
  academicYearId: 'academicYearId',
  type: 'type',
  title: 'title',
  startsAt: 'startDate',
  endsAt: 'endTime',
  venue: 'venue',
  details: 'details',
  charge: 'amount',
  'charge.amount': 'amount',
  'charge.dueOn': 'dueOn',
};

function defaultsOf(event: EventDto | undefined): Values {
  if (!event) {
    return {
      academicYearId: '',
      type: 'ptm',
      title: '',
      startDate: '',
      startTime: '09:00',
      endDate: '',
      endTime: '12:00',
      venue: '',
      details: '',
      sectionIds: [],
      hasCharge: false,
      amount: '',
      dueOn: '',
    };
  }
  const starts = instantToLocal(event.startsAt);
  const ends = instantToLocal(event.endsAt);
  return {
    academicYearId: event.academicYearId,
    type: event.type,
    title: event.title,
    startDate: starts.slice(0, 10),
    startTime: starts.slice(11, 16),
    endDate: ends.slice(0, 10) === starts.slice(0, 10) ? '' : ends.slice(0, 10),
    endTime: ends.slice(11, 16),
    venue: event.venue,
    details: event.details ?? '',
    sectionIds: event.sections.map((s) => s.sectionId),
    hasCharge: event.charge !== null,
    amount: event.charge ? String(event.charge.amount) : '',
    dueOn: event.charge?.dueOn ?? '',
  };
}

/** School time as an instant with the Karachi offset (`2026-11-14T09:00:00+05:00`). */
const instantsOf = (v: Values) => ({
  startsAt: `${v.startDate}T${v.startTime}:00+05:00`,
  endsAt: `${v.endDate || v.startDate}T${v.endTime}:00+05:00`,
});
const sameInstant = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();

function createBody(v: Values): CreateEventBody {
  return {
    academicYearId: v.academicYearId,
    type: v.type as EventType,
    title: v.title.trim(),
    ...instantsOf(v),
    venue: v.venue.trim(),
    ...(v.details.trim() && { details: v.details.trim() }),
    sectionIds: v.sectionIds,
    ...(v.hasCharge && { charge: { amount: Number(v.amount), ...(v.dueOn && { dueOn: v.dueOn }) } }),
  };
}

/** Only what changed: an unchanged charge is left out, so editing a charged draft needs no fee keys. */
function updateBody(v: Values, event: EventDto): UpdateEventBody {
  const before = defaultsOf(event);
  const body: UpdateEventBody = {};
  if (v.type !== before.type) body.type = v.type as EventType;
  if (v.title.trim() !== before.title) body.title = v.title.trim();
  const { startsAt, endsAt } = instantsOf(v);
  if (!sameInstant(startsAt, event.startsAt)) body.startsAt = startsAt;
  if (!sameInstant(endsAt, event.endsAt)) body.endsAt = endsAt;
  if (v.venue.trim() !== before.venue) body.venue = v.venue.trim();
  if (v.details.trim() !== before.details) body.details = v.details.trim() || null;
  if ([...v.sectionIds].sort().join() !== [...before.sectionIds].sort().join()) body.sectionIds = v.sectionIds;
  if (!v.hasCharge && before.hasCharge) body.charge = null;
  if (v.hasCharge && (!before.hasCharge || v.amount !== before.amount || v.dueOn !== before.dueOn)) {
    body.charge = { amount: Number(v.amount), ...(v.dueOn && { dueOn: v.dueOn }) };
  }
  return body;
}

export function EventForm({ event }: { event?: EventDto }) {
  const { can } = useCapabilities();
  const title = event ? 'Edit event' : 'New event';
  if (!can(Capability.HOLIDAY_MANAGE)) {
    return (
      <>
        <BackLink href={event ? eventHref(event.id) : '/events'}>{event ? 'Event' : 'Events'}</BackLink>
        <PageHeader title={title} />
        <StateCard>
          <NoPermissionState description="Events are set up by the principal, or by staff given the calendar permission." />
        </StateCard>
      </>
    );
  }
  return <Form event={event} canCharge={can(Capability.CHARGE_CREATE) && can(Capability.CHARGE_CAMPAIGN_SEND)} />;
}

function Form({ event, canCharge }: { event?: EventDto; canCharge: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const detailsId = useId();
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const years = useYears();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaultsOf(event) });
  const [yearId, hasCharge] = useWatch({ control: form.control, name: ['academicYearId', 'hasCharge'] });
  // A new event defaults to the year in progress, once the years have loaded.
  const activeYearId = years.data?.data.find((y) => y.status === 'active')?.id;
  useEffect(() => {
    if (!event && activeYearId && form.getValues('academicYearId') === '') form.setValue('academicYearId', activeYearId);
  }, [event, activeYearId, form]);
  const sections = useYearSections(yearId);

  const save = useMutation({
    mutationFn: async (values: Values) => {
      if (!event) {
        return unwrap(
          eventsApi.POST('/api/v1/events', {
            params: { header: { 'Idempotency-Key': idempotencyKey } },
            body: createBody(values),
          }),
        );
      }
      const body = updateBody(values, event);
      if (Object.keys(body).length === 0) return event;
      return unwrap(eventsApi.PATCH('/api/v1/events/{id}', { params: { path: { id: event.id } }, body }));
    },
    onSuccess: (row) => {
      queryClient.setQueryData(eventKeys.detail(row.id), row);
      void queryClient.invalidateQueries({ queryKey: eventKeys.list });
      toast.success(event ? 'Event saved.' : 'Draft event created. Publish it to invite the families.');
      router.push(eventHref(row.id));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.IDEMPOTENCY_KEY_REUSED) setIdempotencyKey(newIdempotencyKey());
      applyEventErrors(form, error);
    },
  });

  const yearOptions = [
    { value: '', label: years.isPending ? 'Loading…' : 'Choose a year' },
    ...(years.data?.data ?? []).filter((y) => y.status !== 'closed' || y.id === event?.academicYearId).map((y) => ({ value: y.id, label: y.name })),
  ];

  return (
    <>
      <BackLink href={event ? eventHref(event.id) : '/events'}>{event ? 'Event' : 'Events'}</BackLink>
      <PageHeader
        title={event ? 'Edit event' : 'New event'}
        description="Saved as a draft. Families are invited, and any charge raised, only when you publish it."
      />
      <form className="grid max-w-3xl gap-6" noValidate onSubmit={form.handleSubmit((values) => save.mutate(values))}>
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="academicYearId" label="Academic year" options={yearOptions} disabled={event !== undefined} />
            <FormField control={form.control} name="type" label="Type" options={TYPE_OPTIONS} />
            <div className="sm:col-span-2">
              <FormField control={form.control} name="title" label="Title" maxLength={TITLE_MAX} autoComplete="off" />
            </div>
            <FormField control={form.control} name="startDate" label="Date" type="date" />
            <FormField control={form.control} name="startTime" label="Starts at" type="time" />
            <FormField
              control={form.control}
              name="endDate"
              label="Ends on (if a later day)"
              type="date"
              hint="Leave empty when it ends the same day."
            />
            <FormField control={form.control} name="endTime" label="Ends at" type="time" />
            <div className="sm:col-span-2">
              <FormField control={form.control} name="venue" label="Venue" maxLength={VENUE_MAX} autoComplete="off" />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor={detailsId}>Details (optional)</Label>
              <Textarea
                id={detailsId}
                rows={4}
                maxLength={DETAILS_MAX}
                aria-invalid={form.formState.errors.details ? true : undefined}
                {...form.register('details')}
              />
              {form.formState.errors.details ? (
                <p className="text-xs text-destructive">{form.formState.errors.details.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Sent with the invitation. No phone or identity numbers.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-3">
            <div className="grid gap-0.5">
              <h2 className="text-sm font-medium">Sections</h2>
              <p className="text-xs text-muted-foreground">The families of these sections are invited. At least one is needed to publish.</p>
            </div>
            <Controller
              control={form.control}
              name="sectionIds"
              render={({ field }) =>
                yearId === '' ? (
                  <p className="text-sm text-muted-foreground">Choose the academic year first.</p>
                ) : sections.isPending ? (
                  <p className="text-sm text-muted-foreground">Loading sections…</p>
                ) : sections.isError ? (
                  <p className="text-sm text-destructive">The sections could not be loaded. Reload the page.</p>
                ) : (sections.data ?? []).every((c) => c.sections.length === 0) ? (
                  <p className="text-sm text-muted-foreground">This year has no sections yet.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Sections">
                    {(sections.data ?? []).map((klass) =>
                      klass.sections.length === 0 ? null : (
                        <fieldset key={klass.id} className="grid gap-1.5">
                          <legend className="mb-1 text-xs font-medium text-muted-foreground">{klass.name}</legend>
                          {klass.sections.map((s) => {
                            const checked = field.value.includes(s.id);
                            return (
                              <label key={s.id} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  className="size-4 accent-primary"
                                  checked={checked}
                                  onChange={() => field.onChange(checked ? field.value.filter((x) => x !== s.id) : [...field.value, s.id])}
                                />
                                {klass.name} {s.name}
                              </label>
                            );
                          })}
                        </fieldset>
                      ),
                    )}
                  </div>
                )
              }
            />
            {form.formState.errors.sectionIds && (
              <p className="text-xs text-destructive">{form.formState.errors.sectionIds.message}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid gap-4">
            {canCharge ? (
              <>
                <CheckboxField
                  control={form.control}
                  name="hasCharge"
                  label="Charge families for this event"
                  hint="Raised under the event fee head on publishing, one charge per student of the chosen sections. Concessions do not apply."
                />
                {hasCharge && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField control={form.control} name="amount" label="Amount (Rs)" inputMode="numeric" format={digitsOnly} autoComplete="off" />
                    <FormField
                      control={form.control}
                      name="dueOn"
                      label="Due on (optional)"
                      type="date"
                      hint="Leave empty to make it due on the event day."
                    />
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {event?.charge
                  ? 'This event has a charge. Only staff who raise fee charges can change it.'
                  : 'Only staff who raise fee charges can add a charge to an event.'}
              </p>
            )}
          </CardContent>
        </Card>

        <FormRootError form={form} />
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : event ? 'Save changes' : 'Save draft'}
          </Button>
          <Button type="button" variant="outline" disabled={save.isPending} onClick={() => router.push(event ? eventHref(event.id) : '/events')}>
            Cancel
          </Button>
        </div>
      </form>
    </>
  );
}

/** A 422's field errors on this form's fields (`sectionIds[i]` on the sections), anything else above Save. */
function applyEventErrors(form: ReturnType<typeof useForm<Values>>, error: unknown) {
  if (error instanceof ApiError && error.fieldErrors.length > 0) {
    const unmatched: string[] = [];
    for (const { path, code, message } of error.fieldErrors) {
      const field = path.startsWith('sectionIds') ? 'sectionIds' : FIELD_OF[path];
      const text =
        code === ErrorCode.REFERENCE_NOT_FOUND
          ? field === 'sectionIds'
            ? 'A section is archived or not of this year. Untick it.'
            : field === 'amount'
              ? 'The school has no event fee head. Add one under Fees first.'
              : message
          : message;
      if (field) form.setError(field, { type: code, message: text });
      else unmatched.push(message);
    }
    if (unmatched.length > 0) form.setError('root.server', { message: unmatched.join(' ') });
    return;
  }
  form.setError('root.server', { message: eventErrorMessage(error) });
}
