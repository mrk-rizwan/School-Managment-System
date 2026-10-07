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
import { SearchField } from '@/components/list-filters';
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
  type SubjectDto,
  type SubjectListQuery,
  type SubjectSort,
  type UpdateSubjectBody,
} from '@/lib/api/school-academics-contract';
import { useDebounced, useListPage } from '@/lib/hooks';
import { useCapabilities } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import {
  academicsKeys,
  ArchivedBadge,
  ArchiveDialog,
  ShowArchivedToggle,
} from '../_lib/academics-ui';

const LIMIT = 25;


/** contracts/slice-3.md §5. */
export function SubjectList() {
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const canManage = can(Capability.SUBJECT_MANAGE);
  const [sort, setSort] = useState<SubjectSort>('name');
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const typed = useDebounced(search).trim();
  // q is 2–50 characters (§5.1); a single character is not sent.
  const q = typed.length >= 2 ? typed.slice(0, 50) : undefined;
  const [editing, setEditing] = useState<SubjectDto | 'new' | null>(null);
  const [archiving, setArchiving] = useState<SubjectDto | null>(null);

  const [page, setPage] = useListPage([sort, showArchived, q]);

  const query: SubjectListQuery = {
    page,
    limit: LIMIT,
    sort,
    includeArchived: showArchived,
    ...(q && { q }),
  };
  const subjects = useQuery({
    queryKey: [...academicsKeys.subjects, 'list', query],
    queryFn: () => unwrap(academics.GET('/api/v1/subjects', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  const columns = useMemo(() => {
    const column = createColumnHelper<DataTableFeatures, SubjectDto>();
    return [
      column.accessor('name', {
        header: () => <SortHeader field="name" label="Subject" sort={sort} onSort={setSort} />,
        cell: (info) => (
          <span className="flex items-center gap-2">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.archivedAt && <ArchivedBadge />}
          </span>
        ),
      }),
      column.accessor('code', {
        header: () => <SortHeader field="code" label="Code" sort={sort} onSort={setSort} />,
        cell: (info) => {
          const code = info.getValue();
          return code ? (
            <span className="font-mono text-xs">{code.toUpperCase()}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const subject = info.row.original;
          const actions: RowAction[] =
            canManage && !subject.archivedAt
              ? [
                  { label: 'Edit', onSelect: () => setEditing(subject) },
                  { label: 'Archive', onSelect: () => setArchiving(subject), destructive: true },
                ]
              : [];
          return <RowActions label={subject.name} actions={actions} />;
        },
      }),
    ];
  }, [sort, canManage]);

  const filtered = Boolean(q);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <SearchField value={search} onChange={setSearch} placeholder="Name or code" maxLength={50} />
          <ShowArchivedToggle checked={showArchived} onChange={setShowArchived} />
        </div>
        {canManage && (
          <Button onClick={() => setEditing('new')}>
            <PlusIcon />
            New subject
          </Button>
        )}
      </div>
      <DataTable
        columns={columns}
        query={subjects}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        emptyTitle={filtered ? 'No subjects match' : 'No subjects yet'}
        emptyDescription={
          filtered ? 'Try a different name or code.' : 'Subjects are shared by every class and year.'
        }
      />
      <SubjectFormDialog subject={editing} onClose={() => setEditing(null)} />
      <ArchiveDialog
        target={archiving?.name ?? null}
        noun="subject"
        onClose={() => setArchiving(null)}
        archive={(reason) =>
          unwrap(
            academics.POST('/api/v1/subjects/{id}/archive', {
              params: { path: { id: archiving!.id } },
              body: reason ? { reason } : {},
            }),
          )
        }
        onArchived={() => void queryClient.invalidateQueries({ queryKey: academicsKeys.subjects })}
      />
    </>
  );
}

// ---- Create and edit (§5.3, §5.4) ----

const subjectSchema = z.object({
  name: nameSchema(1, 100),
  // Blank = no code. Upper-cased here as the API does, so the user sees what is stored.
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z0-9-]{1,20})?$/, 'Up to 20 letters, digits or dashes.'),
});
type SubjectValues = z.infer<typeof subjectSchema>;

function SubjectFormDialog({
  subject,
  onClose,
}: {
  subject: SubjectDto | 'new' | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={subject !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {subject !== null && (
          <SubjectForm subject={subject === 'new' ? null : subject} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SubjectForm({ subject, onDone }: { subject: SubjectDto | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const form = useForm<z.input<typeof subjectSchema>, unknown, SubjectValues>({
    resolver: zodResolver(subjectSchema),
    defaultValues: { name: subject?.name ?? '', code: subject?.code ?? '' },
  });

  const save = useMutation({
    mutationFn: (values: SubjectValues) => {
      const code = values.code === '' ? null : values.code;
      if (!subject) {
        return unwrap(academics.POST('/api/v1/subjects', { body: { name: values.name, code } }));
      }
      const body: UpdateSubjectBody = {
        ...(values.name !== subject.name && { name: values.name }),
        ...(code !== subject.code && { code }),
      };
      return unwrap(
        academics.PATCH('/api/v1/subjects/{id}', { params: { path: { id: subject.id } }, body }),
      );
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: academicsKeys.subjects });
      toast.success(subject ? `${saved.name} saved.` : `${saved.name} added.`);
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === ErrorCode.SUBJECT_NAME_TAKEN) {
        form.setError('name', { message: error.message }, { shouldFocus: true });
        return;
      }
      if (error instanceof ApiError && error.code === ErrorCode.SUBJECT_CODE_TAKEN) {
        form.setError('code', { message: error.message }, { shouldFocus: true });
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
        if (subject && !isDirty) return onDone();
        save.mutate(values);
      })}
    >
      <DialogHeader>
        <DialogTitle>{subject ? `Edit ${subject.name}` : 'New subject'}</DialogTitle>
        <DialogDescription>Subjects are shared by every class and academic year.</DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField control={form.control} name="name" label="Name" maxLength={100} autoFocus />
      <FormField
        control={form.control}
        name="code"
        label="Code (optional)"
        hint="For example MATH-5. Stored in capitals."
        autoComplete="off"
        maxLength={20}
      />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : subject ? 'Save changes' : 'Add subject'}
        </Button>
      </DialogFooter>
    </form>
  );
}
