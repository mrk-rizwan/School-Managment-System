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
import {
  studentsApi,
  type EnrolmentDto,
  type StudentDetailDto,
} from '@/lib/api/school-students-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities } from '@/lib/school-session';
import { useSections } from '../../academics/_lib/options';
import { PlacementSelects, type Placement } from '../_lib/placement';
import { ENROLMENT_STATUS_LABELS, studentsKeys } from '../_lib/students-ui';

const LIMIT = 25;

/** contracts/slice-6.md §5 (R37–R39). Only the active enrolment can be changed. */
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

/** POST /enrolments/:id/change-section — in place, same class; the roll number is cleared. */
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
  const sections = useSections(enrolment?.classId ?? '');
  const options = (sections.data?.data ?? []).filter((s) => s.id !== enrolment?.sectionId);
  const close = () => {
    change.reset();
    setSectionId('');
    onClose();
  };
  const change = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        studentsApi.POST('/api/v1/enrolments/{id}/change-section', {
          params: { path: { id: enrolment!.id } },
          body: { sectionId, ...(reason && { reason }) },
        }),
      ),
    onSuccess: (updated) => {
      toast.success(`Moved to ${updated.className} ${updated.sectionName}.`);
      onDone();
      close();
    },
  });
  return (
    <ConfirmWithReasonDialog
      open={enrolment !== null}
      onOpenChange={(open) => !open && close()}
      title="Change section"
      description={`Within ${enrolment?.className ?? 'the class'}. The roll number is cleared; set a new one afterwards. A reason is optional.`}
      confirmLabel="Change section"
      minLength={0}
      maxLength={500}
      pending={change.isPending}
      confirmDisabled={sectionId === ''}
      onConfirm={(reason) => change.mutate(reason)}
    >
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
      {change.error && (
        <Alert variant="destructive">
          <AlertDescription>{describeApiError(change.error)}</AlertDescription>
        </Alert>
      )}
    </ConfirmWithReasonDialog>
  );
}

/**
 * POST /enrolments/:id/change-class — a class of the same year (R38). The old enrolment is
 * closed and a new one opened on the same date (R39); never an edit.
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
  const dateId = useId();
  const today = todayInSchool();
  const [placement, setPlacement] = useState<Placement>({ academicYearId: '', classId: '', sectionId: '' });
  const [effectiveOn, setEffectiveOn] = useState(today);
  const close = () => {
    change.reset();
    setPlacement({ academicYearId: '', classId: '', sectionId: '' });
    setEffectiveOn(todayInSchool());
    onClose();
  };
  const change = useMutation({
    mutationFn: (reason: string) =>
      unwrap(
        studentsApi.POST('/api/v1/enrolments/{id}/change-class', {
          params: { path: { id: enrolment!.id } },
          body: { classId: placement.classId, sectionId: placement.sectionId, effectiveOn, reason },
        }),
      ),
    onSuccess: (created) => {
      toast.success(`Moved to ${created.className} ${created.sectionName}.`);
      onDone();
      close();
    },
  });
  const sameClass = enrolment !== null && placement.classId === enrolment.classId;
  const dateProblem =
    effectiveOn > today
      ? 'The date cannot be in the future.'
      : enrolment && effectiveOn < enrolment.startedOn
        ? 'The date cannot be before the current enrolment started.'
        : null;

  return (
    <ConfirmWithReasonDialog
      open={enrolment !== null}
      onOpenChange={(open) => !open && close()}
      title="Change class"
      description={`Within ${enrolment?.academicYearName ?? 'the same year'}. The current enrolment ends and a new one starts on the date below, without a roll number.`}
      confirmLabel="Change class"
      minLength={3}
      maxLength={500}
      pending={change.isPending}
      confirmDisabled={!placement.classId || !placement.sectionId || sameClass || dateProblem !== null}
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
          <div className="grid gap-1.5">
            <Label htmlFor={dateId}>Effective from</Label>
            <Input
              id={dateId}
              type="date"
              value={effectiveOn}
              min={enrolment.startedOn}
              max={today}
              disabled={change.isPending}
              aria-invalid={dateProblem ? true : undefined}
              onChange={(event) => setEffectiveOn(event.target.value)}
            />
            {dateProblem && <p className="text-xs text-destructive">{dateProblem}</p>}
          </div>
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
