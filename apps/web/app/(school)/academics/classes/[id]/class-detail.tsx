'use client';

import { Capability, ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createColumnHelper } from '@tanstack/react-table';
import { PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  DataTable,
  type DataTableFeatures,
  type RowAction,
  RowActions,
  SortHeader,
} from '@/components/data-table';
import { FormField, FormRootError, applyApiError } from '@/components/form-field';
import { BackLink, QueryStates } from '@/components/page-states';
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
import { ApiError } from '@/lib/api/errors';
import {
  academics,
  type ClassDto,
  type SectionDto,
  type SectionListQuery,
  type SectionSort,
  type UpdateSectionBody,
} from '@/lib/api/school-academics-contract';
import { useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import {
  academicsKeys,
  ArchivedBadge,
  ArchiveDialog,
  ATTENDANCE_MODE_LABELS,
  ShowArchivedToggle,
  YearStatusBadge,
} from '../../_lib/academics-ui';
import { useYears } from '../../_lib/options';
import { CopySectionsDialog } from '../class-dialogs';
import { ClassSubjects } from './class-subjects';

const LIMIT = 25;

/** Class detail: its sections (contracts/slice-3.md §4, §8) and, since Phase 4, its subjects (slice-29.md §5). */
export function ClassDetail({ id }: { id: string }) {
  const klass = useQuery({
    queryKey: academicsKeys.class(id),
    queryFn: () => unwrap(academics.GET('/api/v1/classes/{id}', { params: { path: { id } } })),
  });

  return (
    <>
      <BackLink
        href={klass.data ? `/academics/classes?year=${klass.data.academicYearId}` : '/academics/classes'}
      >
        Classes
      </BackLink>
      <QueryStates
        query={klass}
        loadingRows={4}
        notFound={{ title: 'Class not found', description: 'Find it in the classes list.' }}
      >
        {(data) => <Sections klass={data} />}
      </QueryStates>
    </>
  );
}

function Sections({ klass }: { klass: ClassDto }) {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const years = useYears();
  const yearList = years.data?.data ?? [];
  const year = yearList.find((y) => y.id === klass.academicYearId);
  // Writes need the class active and its year known and not closed (§4.3); the API repeats it.
  const writable = klass.status === 'active' && year !== undefined && year.status !== 'closed';
  const canManage = can(Capability.SECTION_MANAGE) && writable;
  const canCopy = can(Capability.CLASS_MANAGE) && writable;

  const [sort, setSort] = useState<SectionSort>('name');
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useListPage([sort, showArchived]);
  const [editing, setEditing] = useState<SectionDto | 'new' | null>(null);
  const [archiving, setArchiving] = useState<SectionDto | null>(null);
  const [copying, setCopying] = useState(false);

  const query: SectionListQuery = {
    page,
    limit: LIMIT,
    sort,
    includeArchived: showArchived,
  };
  const sections = useQuery({
    queryKey: [...academicsKeys.sections(klass.id), query],
    queryFn: () =>
      unwrap(
        academics.GET('/api/v1/classes/{id}/sections', {
          params: { path: { id: klass.id }, query },
        }),
      ),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, SectionDto>();
    return [
      column.accessor('name', {
        header: () => <SortHeader field="name" label="Section" sort={sort} onSort={setSort} />,
        cell: (info) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.archivedAt && <ArchivedBadge />}
          </span>
        ),
      }),
      column.accessor('capacity', {
        header: 'Capacity',
        cell: (info) => {
          const capacity = info.getValue();
          return capacity === null ? (
            <span className="text-muted-foreground">Not set</span>
          ) : (
            <span className="tabular-nums">{capacity}</span>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const section = info.row.original;
          const actions: RowAction[] =
            canManage && !section.archivedAt
              ? [
                  { label: 'Edit', onSelect: () => setEditing(section) },
                  { label: 'Archive', onSelect: () => setArchiving(section), destructive: true },
                ]
              : [];
          return <RowActions label={`section ${section.name}`} actions={actions} />;
        },
      }),
    ];
  }, [sort, canManage]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            {klass.name}
            {klass.status === 'archived' && <ArchivedBadge />}
          </h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{klass.academicYearName}</span>
            {year && <YearStatusBadge status={year.status} />}
            <span aria-hidden="true">·</span>
            <span>Attendance {ATTENDANCE_MODE_LABELS[klass.attendanceMode].toLowerCase()}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCopy && (
            <Button variant="outline" onClick={() => setCopying(true)}>
              Copy sections from…
            </Button>
          )}
          {canManage && (
            <Button onClick={() => setEditing('new')}>
              <PlusIcon />
              Add section
            </Button>
          )}
        </div>
      </div>
      {!writable && year && (
        <p className="mb-4 text-sm text-muted-foreground">
          {klass.status === 'archived'
            ? 'This class is archived. Its sections are kept for the record and cannot be changed.'
            : `${year.name} is closed. Its sections cannot be changed.`}
        </p>
      )}
      <div className="mb-4">
        <ShowArchivedToggle checked={showArchived} onChange={setShowArchived} />
      </div>
      <DataTable
        columns={columns}
        query={sections}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={showArchived ? 'No sections' : 'No sections yet'}
        emptyDescription={
          canManage
            ? 'Add sections one by one, or copy them from another class.'
            : 'Sections added to this class appear here.'
        }
      />
      <SectionFormDialog classId={klass.id} section={editing} onClose={() => setEditing(null)} />
      <CopySectionsDialog
        target={copying ? klass : null}
        years={yearList}
        onClose={() => setCopying(false)}
      />
      <ArchiveDialog
        target={archiving ? `Section ${archiving.name}` : null}
        noun="section"
        onClose={() => setArchiving(null)}
        archive={(reason) =>
          unwrap(
            academics.POST('/api/v1/sections/{id}/archive', {
              params: { path: { id: archiving!.id } },
              body: reason ? { reason } : {},
            }),
          )
        }
        onArchived={() =>
          void queryClient.invalidateQueries({ queryKey: academicsKeys.sections(klass.id) })
        }
      />
      <ClassSubjects klass={klass} years={yearList} writable={writable} />
    </>
  );
}

// ---- Add and edit (§4.3, §4.4) ----

const sectionSchema = z.object({
  name: nameSchema(1, 20),
  // Blank = no capacity. Informational only in Phase 1.
  capacity: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || (/^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 200),
      'Enter a number from 1 to 200, or leave it blank.',
    ),
});
type SectionValues = z.infer<typeof sectionSchema>;

function SectionFormDialog({
  classId,
  section,
  onClose,
}: {
  classId: string;
  section: SectionDto | 'new' | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={section !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {section !== null && (
          <SectionForm
            classId={classId}
            section={section === 'new' ? null : section}
            onDone={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SectionForm({
  classId,
  section,
  onDone,
}: {
  classId: string;
  section: SectionDto | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<SectionValues>({
    resolver: zodResolver(sectionSchema),
    defaultValues: {
      name: section?.name ?? '',
      capacity: section?.capacity === null || !section ? '' : String(section.capacity),
    },
  });

  const save = useMutation({
    mutationFn: (values: SectionValues) => {
      const capacity = values.capacity === '' ? null : Number(values.capacity);
      if (!section) {
        return unwrap(
          academics.POST('/api/v1/classes/{id}/sections', {
            params: { path: { id: classId } },
            body: { name: values.name, capacity },
          }),
        );
      }
      const body: UpdateSectionBody = {
        ...(values.name !== section.name && { name: values.name }),
        ...(capacity !== section.capacity && { capacity }),
      };
      return unwrap(
        academics.PATCH('/api/v1/sections/{id}', { params: { path: { id: section.id } }, body }),
      );
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: academicsKeys.sections(classId) });
      toast.success(section ? `Section ${saved.name} saved.` : `Section ${saved.name} added.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.SECTION_NAME_TAKEN) {
        form.setError('name', { message: error.message }, { shouldFocus: true });
        return;
      }
      applyApiError(form, error);
    },
  });
  // Read during render: react-hook-form tracks isDirty only once the proxy has been read, so a
  // first read inside the submit handler returned a stale false and an edit was never sent.
  const { isDirty } = form.formState;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit((values) => {
        if (section && !isDirty) return onDone();
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{section ? `Edit section ${section.name}` : 'Add section'}</DialogTitle>
        <DialogDescription>Capacity is for reference; it does not limit admissions.</DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="name" label="Name" hint="For example A or Blue." maxLength={20} autoFocus />
      <FormField
        control={form.control}
        name="capacity"
        label="Capacity (optional)"
        type="number"
        inputMode="numeric"
      />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : section ? 'Save changes' : 'Add section'}
        </Button>
      </DialogFooter>
    </form>
  );
}
