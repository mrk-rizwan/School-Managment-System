'use client';

import { Capability, DEFAULT_EXAM_MAX_MARKS, MAX_ASSESSMENT_MARKS } from '@asms/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
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
import { Textarea } from '@/components/ui/textarea';
import { unwrap } from '@/lib/api/client';
import { ApiError, toastApiError } from '@/lib/api/errors';
import {
  academics,
  type AcademicYearDto,
  type ClassDto,
  type ClassSubjectDto,
} from '@/lib/api/school-academics-contract';
import { useCapabilities } from '@/lib/school-session';
import { academicsKeys, YEAR_STATUS_LABELS } from '../../_lib/academics-ui';
import { useClasses, useSubjectOptions } from '../../_lib/options';

// The class page's Subjects (contracts/slice-29.md §5, phase-4-academic.md slice 29): the subjects
// the class takes in print order with each exam's default max marks, and the promotion link (the
// next class, or the final class).

const LIMIT = 50;

export function ClassSubjects({
  klass,
  years,
  writable,
}: {
  klass: ClassDto;
  years: AcademicYearDto[];
  writable: boolean;
}) {
  const { can } = useCapabilities();
  const canManage = can(Capability.CLASS_MANAGE) && writable;
  const [editing, setEditing] = useState(false);
  const query = { page: 1, limit: LIMIT, sort: 'sortOrder' } as const;
  const subjects = useQuery({
    queryKey: [...academicsKeys.classSubjects(klass.id), query],
    queryFn: () =>
      unwrap(academics.GET('/api/v1/classes/{id}/subjects', { params: { path: { id: klass.id }, query } })),
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, ClassSubjectDto>();
    return [
      column.accessor('subjectName', {
        header: 'Subject',
        cell: (info) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.subjectCode && (
              <span className="text-xs text-muted-foreground">{info.row.original.subjectCode}</span>
            )}
          </span>
        ),
      }),
      column.accessor('examMaxMarks', {
        header: 'Exam out of',
        cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
      }),
    ];
  }, []);

  return (
    <section aria-labelledby="class-subjects-heading" className="mt-10 grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h2 id="class-subjects-heading" className="text-lg font-semibold tracking-tight">
            Subjects
          </h2>
          <p className="text-sm text-muted-foreground">
            The same for every section of the class, in the order the report card prints them.
          </p>
        </div>
        {canManage && (
          <Button variant="outline" onClick={() => setEditing(true)} disabled={!subjects.data}>
            Edit subjects
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        query={subjects}
        getRowId={(row) => row.id}
        page={1}
        limit={LIMIT}
        onPageChange={() => undefined}
        emptyTitle="No subjects yet"
        emptyDescription={canManage ? 'Choose the subjects this class takes.' : 'Subjects set for this class appear here.'}
      />
      {editing && subjects.data && (
        <EditSubjectsDialog klass={klass} current={subjects.data.data} onClose={() => setEditing(false)} />
      )}
      {/* Mounted once the years are known: the next class's year is preselected from them. */}
      {years.length > 0 && <PromotionLink klass={klass} years={years} canManage={canManage} />}
    </section>
  );
}

// ---- Edit the list (§5) ----

type Row = { subjectId: string; name: string; examMaxMarks: string };

function EditSubjectsDialog({
  klass,
  current,
  onClose,
}: {
  klass: ClassDto;
  current: ClassSubjectDto[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const allSubjects = useSubjectOptions();
  const [rows, setRows] = useState<Row[]>(
    current.map((c) => ({ subjectId: c.subjectId, name: c.subjectName, examMaxMarks: String(c.examMaxMarks) })),
  );
  const [adding, setAdding] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const addId = useId();
  const reasonId = useId();

  const listed = new Set(rows.map((r) => r.subjectId));
  const available = (allSubjects.data?.data ?? []).filter((s) => !s.archivedAt && !listed.has(s.id));
  const removed = current.filter((c) => !listed.has(c.subjectId));

  const move = (index: number, by: -1 | 1) =>
    setRows((list) => {
      const next = [...list];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row!);
      return next;
    });

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        academics.PATCH('/api/v1/classes/{id}', {
          params: { path: { id: klass.id } },
          body: {
            subjects: rows.map((r, i) => ({ subjectId: r.subjectId, sortOrder: i + 1, examMaxMarks: Number(r.examMaxMarks) })),
            ...(removed.length > 0 && { reason: reason.trim() }),
          },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: academicsKeys.classSubjects(klass.id) });
      toast.success(`Subjects of ${klass.name} saved.`);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 422) return setError(e.message);
      toastApiError(e);
    },
  });

  const badMarks = rows.find((r) => !/^\d{1,4}$/.test(r.examMaxMarks) || Number(r.examMaxMarks) < 1 || Number(r.examMaxMarks) > MAX_ASSESSMENT_MARKS);
  const needsReason = removed.length > 0 && reason.trim().length < 3;

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Subjects of {klass.name}</DialogTitle>
          <DialogDescription>
            Order is the report card&apos;s order. A removed subject is archived, not deleted, and needs a reason.
          </DialogDescription>
        </DialogHeader>
        <ol className="grid gap-2" aria-label="Subject list">
          {rows.map((row, index) => (
            <li key={row.subjectId} className="flex items-center gap-2">
              <span className="w-6 text-right text-sm tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.name}</span>
              <Label htmlFor={`${addId}-max-${row.subjectId}`} className="sr-only">
                Exam out of, {row.name}
              </Label>
              <Input
                id={`${addId}-max-${row.subjectId}`}
                className="w-20"
                type="number"
                inputMode="numeric"
                value={row.examMaxMarks}
                onChange={(event) =>
                  setRows((list) => list.map((r) => (r.subjectId === row.subjectId ? { ...r, examMaxMarks: event.target.value } : r)))
                }
              />
              <Button type="button" variant="ghost" size="icon" aria-label={`Move ${row.name} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move ${row.name} down`}
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${row.name}`}
                onClick={() => setRows((list) => list.filter((r) => r.subjectId !== row.subjectId))}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
          {rows.length === 0 && <li className="text-sm text-muted-foreground">No subjects in the list.</li>}
        </ol>
        <div className="flex items-end gap-2">
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor={addId}>Add a subject</Label>
            <NativeSelect id={addId} value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">Choose a subject</option>
              {available.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={adding === ''}
            onClick={() => {
              const subject = available.find((s) => s.id === adding);
              if (subject) setRows((list) => [...list, { subjectId: subject.id, name: subject.name, examMaxMarks: String(DEFAULT_EXAM_MAX_MARKS) }]);
              setAdding('');
            }}
          >
            Add
          </Button>
        </div>
        {removed.length > 0 && (
          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>Why are {removed.map((r) => r.subjectName).join(', ')} removed?</Label>
            <Textarea id={reasonId} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
        )}
        {badMarks && <p className="text-sm text-destructive">Exam marks are a whole number from 1 to {MAX_ASSESSMENT_MARKS}.</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={save.isPending || Boolean(badMarks) || needsReason} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save subjects'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- The promotion link (rule 30) ----

function PromotionLink({ klass, years, canManage }: { klass: ClassDto; years: AcademicYearDto[]; canManage: boolean }) {
  const queryClient = useQueryClient();
  const ownYear = years.find((y) => y.id === klass.academicYearId);
  // The next class usually lives in the following year: preselect the first year after this one.
  const following = [...years]
    .filter((y) => ownYear !== undefined && y.startsOn > ownYear.startsOn)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0];
  const [yearId, setYearId] = useState(following?.id ?? klass.academicYearId);
  const [nextClassId, setNextClassId] = useState(klass.nextClassId ?? '');
  const [isFinal, setIsFinal] = useState(klass.isFinal);
  const classes = useClasses(yearId);
  const yearSelectId = useId();
  const classSelectId = useId();
  const finalId = useId();

  const save = useMutation({
    mutationFn: () =>
      unwrap(
        academics.PATCH('/api/v1/classes/{id}', {
          params: { path: { id: klass.id } },
          body: { nextClassId: isFinal || nextClassId === '' ? null : nextClassId, isFinal },
        }),
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(academicsKeys.class(klass.id), saved);
      toast.success(saved.isFinal ? `${saved.name} is the final class.` : `Promotion from ${saved.name} saved.`);
    },
    onError: toastApiError,
  });

  const unchanged = isFinal === klass.isFinal && (isFinal || (nextClassId || null) === klass.nextClassId);

  return (
    <div className="mt-4 grid gap-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Promotion at year end</h3>
      <p className="text-sm text-muted-foreground">
        {klass.isFinal
          ? 'This is the final class: a student who passes completes school.'
          : klass.nextClassName
            ? `A student who passes is promoted to ${klass.nextClassName}.`
            : 'No next class is set yet.'}
      </p>
      {canManage && (
        <>
          <div className="flex items-start gap-3">
            <input
              id={finalId}
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={isFinal}
              onChange={(event) => setIsFinal(event.target.checked)}
            />
            <label htmlFor={finalId} className="text-sm font-medium">
              This is the final class (passed students complete school)
            </label>
          </div>
          {!isFinal && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor={yearSelectId}>Next class&apos;s year</Label>
                <NativeSelect
                  id={yearSelectId}
                  value={yearId}
                  onChange={(event) => {
                    setYearId(event.target.value);
                    setNextClassId('');
                  }}
                >
                  {years.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name} ({YEAR_STATUS_LABELS[y.status].toLowerCase()})
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={classSelectId}>Next class</Label>
                <NativeSelect id={classSelectId} value={nextClassId} onChange={(event) => setNextClassId(event.target.value)}>
                  <option value="">None</option>
                  {klass.nextClassId && !(classes.data?.data ?? []).some((c) => c.id === klass.nextClassId) && (
                    <option value={klass.nextClassId}>{klass.nextClassName}</option>
                  )}
                  {(classes.data?.data ?? [])
                    .filter((c) => c.id !== klass.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </NativeSelect>
              </div>
            </div>
          )}
          <div>
            <Button type="button" variant="outline" disabled={save.isPending || unchanged} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save promotion'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
