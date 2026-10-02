'use client';

import { ErrorCode } from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { createColumnHelper } from '@tanstack/react-table';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { DataTable, type DataTableFeatures } from '@/components/data-table';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoPermissionState,
} from '@/components/page-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api/errors';

type DemoStudent = { id: string; name: string; className: string; status: 'active' | 'withdrawn' };

// Fake data: invented names, no identity numbers.
const NAMES = ['Ayesha', 'Bilal', 'Fatima', 'Hamza', 'Iqra', 'Junaid', 'Maryam', 'Usman'];
const ALL_STUDENTS: DemoStudent[] = Array.from({ length: 23 }, (_, i) => ({
  id: String(i + 1),
  name: `${NAMES[i % NAMES.length]} ${String.fromCharCode(65 + (i % 26))}.`,
  className: `Class ${(i % 5) + 1}`,
  status: i % 7 === 6 ? 'withdrawn' : 'active',
}));
const NO_ROWS: DemoStudent[] = [];
const LIMIT = 10;

const column = createColumnHelper<DataTableFeatures, DemoStudent>();
const columns = [
  column.accessor('name', { header: 'Name' }),
  column.accessor('className', { header: 'Class' }),
  column.accessor('status', {
    header: 'Status',
    cell: (info) => (
      <Badge variant={info.getValue() === 'active' ? 'secondary' : 'outline'}>
        {info.getValue() === 'active' ? 'Active' : 'Withdrawn'}
      </Badge>
    ),
  }),
];

type TableMode = 'rows' | 'loading' | 'empty' | 'error' | 'forbidden';

const FAKE_ERRORS = {
  error: new ApiError(500, ErrorCode.INTERNAL_ERROR, 'The server had a problem.', null, '01JDEMO000REQUEST'),
  forbidden: new ApiError(403, ErrorCode.PERMISSION_DENIED, 'Permission denied.', null, null),
} as const;

export function Demo() {
  return (
    <div className="grid gap-8">
      <PageHeader
        title="Component demo"
        description="Shared table, form field, confirm dialog and page states, on fake data."
      />
      <TableDemo />
      <div className="grid gap-8 xl:grid-cols-2">
        <FormDemo />
        <DialogDemo />
      </div>
      <StatesDemo />
    </div>
  );
}

function TableDemo() {
  const [mode, setMode] = useState<TableMode>('rows');
  const [page, setPage] = useState(1);
  const rows = mode === 'rows' ? ALL_STUDENTS.slice((page - 1) * LIMIT, page * LIMIT) : NO_ROWS;

  return (
    <section className="grid gap-3" aria-labelledby="table-demo">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="table-demo" className="text-sm font-medium">
          Data table
        </h2>
        <div className="flex flex-wrap gap-1">
          {(['rows', 'loading', 'empty', 'error', 'forbidden'] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? 'secondary' : 'ghost'}
              onClick={() => setMode(m)}
            >
              {m}
            </Button>
          ))}
        </div>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        page={page}
        limit={LIMIT}
        total={mode === 'rows' ? ALL_STUDENTS.length : 0}
        onPageChange={setPage}
        isLoading={mode === 'loading'}
        error={mode === 'error' || mode === 'forbidden' ? FAKE_ERRORS[mode] : undefined}
        onRetry={() => setMode('rows')}
        emptyTitle="No students match"
        emptyDescription="Try a different class or clear the search."
      />
    </section>
  );
}

const guardianSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name.'),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]),
});
type GuardianValues = z.infer<typeof guardianSchema>;

function FormDemo() {
  const form = useForm<GuardianValues>({
    resolver: zodResolver(guardianSchema),
    defaultValues: { fullName: '', email: '' },
  });

  // Simulates the API answering 422 with details.fields, including one path the form lacks.
  const onSubmit = form.handleSubmit(() => {
    const error = new ApiError(
      422,
      ErrorCode.VALIDATION_FAILED,
      'Validation failed.',
      {
        fields: [
          { path: 'email', code: 'DUPLICATE', message: 'This email is already in use.' },
          { path: 'contactCapability', code: 'REQUIRED', message: 'Pick how this guardian is reached.' },
        ],
      },
      '01JDEMO000REQUEST',
    );
    if (!applyApiFieldErrors(form, error)) toast.error(error.message);
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Form field</CardTitle>
        <CardDescription>
          Client validation from zod; submit to see API field errors mapped onto the form.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form noValidate onSubmit={onSubmit} className="grid gap-4">
          <FormRootError form={form} />
          <FormField control={form.control} name="fullName" label="Full name" />
          <FormField
            control={form.control}
            name="email"
            label="Email"
            type="email"
            hint="Optional. Used for password reset."
          />
          <div>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm with reason</CardTitle>
        <CardDescription>
          Confirm is disabled until the reason is long enough, and while the action runs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Withdraw student
        </Button>
        <ConfirmWithReasonDialog
          open={open}
          onOpenChange={setOpen}
          title="Withdraw student"
          description="The student keeps their history. This is recorded with your reason."
          confirmLabel="Withdraw"
          destructive
          pending={pending}
          onConfirm={() => {
            setPending(true);
            setTimeout(() => {
              setPending(false);
              setOpen(false);
              toast.success('Withdrawn (demo only, nothing was saved).');
            }, 1200);
          }}
        />
      </CardContent>
    </Card>
  );
}

function StatesDemo() {
  return (
    <section className="grid gap-3" aria-labelledby="states-demo">
      <h2 id="states-demo" className="text-sm font-medium">
        Page states
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border bg-card">
          <LoadingState rows={3} />
        </div>
        <div className="rounded-lg border bg-card">
          <EmptyState title="No guardians yet" description="Guardians are added at admission." />
        </div>
        <div className="rounded-lg border bg-card">
          <ErrorState error={FAKE_ERRORS.error} onRetry={() => toast('Retry pressed')} />
        </div>
        <div className="rounded-lg border bg-card">
          <NoPermissionState />
        </div>
      </div>
    </section>
  );
}
