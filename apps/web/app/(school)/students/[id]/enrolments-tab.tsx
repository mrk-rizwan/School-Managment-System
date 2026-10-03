'use client';

import { Capability } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { unwrap } from '@/lib/api/client';
import { describeApiError } from '@/lib/api/errors';
import { calendarApi, type SectionChangeResultDto } from '@/lib/api/school-calendar-contract';
import {
  studentsApi,
  type EnrolmentDto,
  type StudentDetailDto,
} from '@/lib/api/school-students-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { useSections } from '../../academics/_lib/options';
import { addDays } from '../../calendar/_lib/calendar-ui';
import { PlacementSelects, type Placement } from '../_lib/placement';
import { ENROLMENT_STATUS_LABELS, studentsKeys } from '../_lib/students-ui';

const LIMIT = 25;

/** contracts/slice-6.md §5 (R37–R39), amended by slice-10 §8. Only the active enrolment can be changed. */
export function EnrolmentsTab({ student }: { student: StudentDetailDto }) {
  const { can } = useCapabilities();
  const canManage = can(Capability.ENROLMENT_MANAGE);
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<{ kind: 'roll' | 'section' | 'class'; enrolment: EnrolmentDto } | null>(
    null,
  );
  const query = { page, limit: LIMIT } as const;
  const enrolments = useQuery({
    queryKey: [...studentsKeys.enrolments(student.id), query],
    queryFn: () =>
      unwrap(
        studentsApi.GET('/api/v1/students/{id}/enrolments', { params: { path: { id: student.id }, query } }),
      ),
    placeholderData: keepPreviousData,
  });
  // The student's current class and the list both change.
  const refresh = () => void queryClient.invalidateQueries({ queryKey: studentsKeys.all });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, EnrolmentDto>();
    return [
      column.accessor('academicYearName', { header: 'Year' }),
      column.display({
        id: 'class',
        header: 'Class',
        cell: (info) => (
          <span className="font-medium">
            {info.row.original.className} {info.row.original.sectionName}
          </span>
        ),
      }),
      column.accessor('rollNo', { header: 'Roll no.', cell: (info) => info.getValue() ?? '—' }),
      column.accessor('status', {
        header: 'Status',
        cell: (info) => (
          <Badge variant={info.getValue() === 'active' ? 'secondary' : 'ghost'}>
            {ENROLMENT_STATUS_LABELS[info.getValue()]}
          </Badge>
        ),
      }),
      column.display({
        id: 'dates',
        header: 'Dates',
        cell: (info) => {
          const { startedOn, endedOn } = info.row.original;
          // slice-10 §8.1: a same-day correction leaves a zero-length enrolment, kept as history.
          if (endedOn && endedOn < startedOn) {
            return <span className="text-muted-foreground">Not in force (corrected)</span>;
          }
          return endedOn ? `${formatDay(startedOn)} – ${formatDay(endedOn)}` : `From ${formatDay(startedOn)}`;
        },
      }),
      ...(canManage
        ? [
            column.display({
              id: 'actions',
              header: () => <span className="sr-only">Actions</span>,
              cell: (info) => {
                const enrolment = info.row.original;
                if (enrolment.status !== 'active') return null;
                return (
                  <RowActions
                    label={`${enrolment.className} ${enrolment.sectionName}`}
                    actions={[
                      { label: 'Set roll number', onSelect: () => setAction({ kind: 'roll', enrolment }) },
                      { label: 'Change section', onSelect: () => setAction({ kind: 'section', enrolment }) },
                      { label: 'Change class', onSelect: () => setAction({ kind: 'class', enrolment }) },
                    ]}
                  />
                );
              },
            }),
          ]
        : []),
    ];
  }, [canManage]);

  const close = () => setAction(null);
  return (
    <>
      <DataTable
        columns={columns}
        query={enrolments}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle="No enrolments"
      />
      {canManage && (
        <>
          <RollNoDialog
            enrolment={action?.kind === 'roll' ? action.enrolment : null}
            onClose={close}
            onDone={refresh}
          />
          <ChangeSectionDialog
            enrolment={action?.kind === 'section' ? action.enrolment : null}
            onClose={close}
            onDone={refresh}
          />
          <ChangeClassDialog
            enrolment={action?.kind === 'class' ? action.enrolment : null}
            onClose={close}
            onDone={refresh}
          />
        </>
      )}
    </>
  );
}

/** PATCH /enrolments/:id — an integer 1–9999, or blank to clear (R37). */
function RollNoDialog({
  enrolment,
  onClose,
  onDone,
}: {
  enrolment: EnrolmentDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Dialog open={enrolment !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {enrolment && <RollNoForm enrolment={enrolment} onClose={onClose} onDone={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

function RollNoForm({
  enrolment,
  onClose,
  onDone,
}: {
  enrolment: EnrolmentDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(enrolment.rollNo?.toString() ?? '');
  const trimmed = value.trim();
  const rollNo = trimmed === '' ? null : Number(trimmed);
  const invalid = rollNo !== null && (!Number.isInteger(rollNo) || rollNo < 1 || rollNo > 9999);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        studentsApi.PATCH('/api/v1/enrolments/{id}', {
          params: { path: { id: enrolment.id } },
          body: { rollNo },
        }),
      ),
    onSuccess: () => {
      toast.success(rollNo === null ? 'Roll number cleared.' : `Roll number set to ${rollNo}.`);
      onDone();
      onClose();
    },
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!invalid && !save.isPending) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Roll number</DialogTitle>
        <DialogDescription>
          {enrolment.className} {enrolment.sectionName}. Each roll number is used once per section.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor={id}>Roll number</Label>
        <Input
          id={id}
          value={value}
          inputMode="numeric"
          maxLength={4}
          autoFocus
          aria-invalid={invalid ? true : undefined}
          onChange={(event) => setValue(event.target.value.replace(/\D/g, ''))}
        />
        <p className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {invalid ? 'Enter a number from 1 to 9999.' : 'Leave blank to clear it.'}
        </p>
      </div>
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{describeApiError(save.error)}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={invalid || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The sentence both change dialogs show (contracts/slice-10.md §8.1, §13): a change closes the
 * current enrolment the day before and opens a new one, without a roll number.
 */
function closeOpenSentence(effectiveOn: string): string {
  if (!effectiveOn) return 'Closes the current enrolment and opens a new one. The roll number must be set again.';
  return `Closes the current enrolment on ${formatDay(addDays(effectiveOn, -1))} and opens a new one from ${formatDay(effectiveOn)}. The roll number must be set again.`;
}

/** The toast after a change names both enrolments (§8.2's `{ closed, opened }`). */
function changedMessage({ closed, opened }: SectionChangeResultDto): string {
  const from = `${closed.className} ${closed.sectionName}`;
  const ended =
    closed.endedOn === null
      ? ''
      : closed.endedOn < closed.startedOn
        ? ` ${from} is kept as not in force (corrected).`
        : ` ${from} ended on ${formatDay(closed.endedOn)}.`;
  return `Now in ${opened.className} ${opened.sectionName} from ${formatDay(opened.startedOn)}.${ended}`;
}

const effectiveOnProblem = (enrolment: EnrolmentDto, value: string): string | null =>
  value === ''
    ? 'Choose the date.'
    : value > todayInSchool()
      ? 'The date cannot be in the future.'
      : value < enrolment.startedOn
        ? 'The date cannot be before the current enrolment started.'
        : null;

/** The date a change takes effect: no later than today, not before the enrolment began. */
function EffectiveOnField({
  enrolment,
  value,
  onChange,
  disabled,
}: {
  enrolment: EnrolmentDto;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const problem = effectiveOnProblem(enrolment, value);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Effective from</Label>
      <Input
        id={id}
        type="date"
        value={value}
        min={enrolment.startedOn}
        max={todayInSchool()}
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}

/**
 * POST /enrolments/:id/change-section — close-old/open-new within the class (R174): the current
 * enrolment ends the day before `effectiveOn` and a new one opens without a roll number. A reason
 * is required.
 */
function ChangeSectionDialog({
  enrolment,
  onClose,
  onDone,
}: {
  enrolment: EnrolmentDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [sectionId, setSectionId] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(todayInSchool());
  const sections = useSections(enrolment?.classId ?? '');
  const options = (sections.data?.data ?? []).filter((s) => s.id !== enrolment?.sectionId && s.archivedAt === null);
  const close = () => {
    change.reset();
    setSectionId('');
    setEffectiveOn(todayInSchool());
    onClose();
  };
  const change = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        calendarApi.POST('/api/v1/enrolments/{id}/change-section', {
          params: { path: { id: enrolment!.id } },
          body: { sectionId, effectiveOn, reason },
        }),
      ),
    onSuccess: (result) => {
      toast.success(changedMessage(result));
      onDone();
      close();
    },
  });
  return (
    <ConfirmWithReasonDialog
      open={enrolment !== null}
      onOpenChange={(open) => !open && close()}
      title="Change section"
      description={`Within ${enrolment?.className ?? 'the class'}. ${closeOpenSentence(effectiveOn)}`}
      confirmLabel="Change section"
      minLength={3}
      maxLength={500}
      pending={change.isPending}
      confirmDisabled={sectionId === '' || enrolment === null || effectiveOnProblem(enrolment, effectiveOn) !== null}
      onConfirm={(reason) => change.mutate(reason)}
    >
      {enrolment && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={id}>New section</Label>
            <NativeSelect id={id} value={sectionId} disabled={change.isPending} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">{sections.isPending ? 'Loading…' : 'Choose…'}</option>
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <EffectiveOnField enrolment={enrolment} value={effectiveOn} onChange={setEffectiveOn} disabled={change.isPending} />
        </div>
      )}
      {change.error && (
        <Alert variant="destructive">
          <AlertDescription>{describeApiError(change.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}

/**
 * POST /enrolments/:id/change-class — a class of the same year (R38), close-old/open-new like a
 * section change (slice-10 §8.3): the current enrolment ends the day before `effectiveOn`.
 */
function ChangeClassDialog({
  enrolment,
  onClose,
  onDone,
}: {
  enrolment: EnrolmentDto | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [placement, setPlacement] = useState<Placement>({ academicYearId: '', classId: '', sectionId: '' });
  const [effectiveOn, setEffectiveOn] = useState(todayInSchool());
  const close = () => {
    change.reset();
    setPlacement({ academicYearId: '', classId: '', sectionId: '' });
    setEffectiveOn(todayInSchool());
    onClose();
  };
  const change = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        calendarApi.POST('/api/v1/enrolments/{id}/change-class', {
          params: { path: { id: enrolment!.id } },
          body: { classId: placement.classId, sectionId: placement.sectionId, effectiveOn, reason },
        }),
      ),
    onSuccess: (result) => {
      toast.success(changedMessage(result));
      onDone();
      close();
    },
  });
  const sameClass = enrolment !== null && placement.classId === enrolment.classId;

  return (
    <ConfirmWithReasonDialog
      open={enrolment !== null}
      onOpenChange={(open) => !open && close()}
      title="Change class"
      description={`Within ${enrolment?.academicYearName ?? 'the same year'}. ${closeOpenSentence(effectiveOn)}`}
      confirmLabel="Change class"
      minLength={3}
      maxLength={500}
      pending={change.isPending}
      confirmDisabled={
        !placement.classId ||
        !placement.sectionId ||
        sameClass ||
        enrolment === null ||
        effectiveOnProblem(enrolment, effectiveOn) !== null
      }
      onConfirm={(reason) => change.mutate(reason)}
    >
      {enrolment && (
        <div className="grid gap-4 sm:grid-cols-2">
          <PlacementSelects
            value={placement}
            onChange={setPlacement}
            fixedYearId={enrolment.academicYearId}
            disabled={change.isPending}
            errors={sameClass ? { classId: 'This is the current class. Use Change section.' } : undefined}
          />
          <EffectiveOnField enrolment={enrolment} value={effectiveOn} onChange={setEffectiveOn} disabled={change.isPending} />
        </div>
      )}
      {change.error && (
        <Alert variant="destructive">
          <AlertDescription>{describeApiError(change.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}
