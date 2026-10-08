'use client';

import {
  Capability,
  MAX_ASSESSMENT_MARKS,
  newIdempotencyKey,
  TEST_TYPE_LABELS,
  TEST_TYPES,
} from '@asms/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { PageHeader } from '@/components/app-shell';
import { FormField, FormRootError, applyApiFieldErrors } from '@/components/form-field';
import { EmptyState, QueryStates, StateCard } from '@/components/page-states';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { academics } from '@/lib/api/school-academics-contract';
import {
  assessmentsApi,
  type AssessmentDto,
  type TestType,
} from '@/lib/api/school-assessments-contract';
import { formatDay, todayInSchool } from '@/lib/format';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { nameSchema } from '@/lib/validation';
import { cn } from '@/lib/utils';
import { mySections, type MySection } from '../attendance/_lib/attendance-ui';
import {
  kindLabel,
  marksErrorMessage,
  marksHref,
  marksKeys,
} from './_lib/marks-ui';

// contracts/slice-30.md §8: the assessments the caller reads (GET /assessments: their sections
// and subjects, or the school with marks.view_all), filtered by one of their sections; "New test"
// for a marks.enter holder in one of their sections. Each row opens the marks grid.

export function MarksHome() {
  const today = todayInSchool();
  const me = useSchoolMe();
  const { can } = useCapabilities();
  const mine = mySections(me.data, today);
  const [sectionId, setSectionId] = useState('');
  const [creating, setCreating] = useState(false);
  const query = { limit: 50, ...(sectionId && { sectionId }) };
  const list = useQuery({
    queryKey: marksKeys.list(query),
    queryFn: () => unwrap(assessmentsApi.GET('/api/v1/assessments', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const mayCreate = can(Capability.MARKS_ENTER) && mine.some((s) => s.subjectIds.length > 0);

  return (
    <>
      <PageHeader
        title="Marks"
        description="Class tests and exams of your sections. Open one to enter or read its marks."
        actions={
          mayCreate && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden />
              New test
            </Button>
          )
        }
      />
      {mine.length > 0 && (
        <div
          className="mb-4 flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Filter by section"
        >
          <span className="text-sm text-muted-foreground">Section:</span>
          {[
            { sectionId: '', label: 'All' },
            ...mine.map((s) => ({
              sectionId: s.sectionId,
              label: `${s.className} ${s.sectionName}`,
            })),
          ].map((s) => (
            <button
              key={s.sectionId || 'all'}
              type="button"
              aria-pressed={sectionId === s.sectionId}
              onClick={() => setSectionId(s.sectionId)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                sectionId === s.sectionId
                  ? 'border-primary bg-primary/10 font-medium'
                  : 'hover:bg-muted',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <QueryStates query={list} loadingRows={6}>
        {(page) =>
          page.data.length === 0 ? (
            <StateCard>
              <EmptyState
                title="No tests yet"
                description={
                  mayCreate
                    ? 'Create a class test, or wait for the term’s exams to be set up.'
                    : 'Nothing to show for your sections.'
                }
              />
            </StateCard>
          ) : (
            <AssessmentTable rows={page.data} total={page.total} />
          )
        }
      </QueryStates>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          {creating && (
            <NewTestForm
              sections={mine.filter((s) => s.subjectIds.length > 0)}
              onDone={() => setCreating(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AssessmentTable({ rows, total }: { rows: AssessmentDto[]; total: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-4 text-muted-foreground">Held on</TableHead>
            <TableHead className="px-4 text-muted-foreground">Name</TableHead>
            <TableHead className="px-4 text-muted-foreground">Section</TableHead>
            <TableHead className="px-4 text-muted-foreground">Subject</TableHead>
            <TableHead className="px-4 text-right text-muted-foreground">Max</TableHead>
            <TableHead className="px-4 text-right text-muted-foreground">Marked</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="px-4 whitespace-nowrap">{formatDay(a.heldOn)}</TableCell>
              <TableCell className="px-4">
                <Link
                  href={marksHref(a.id)}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {a.name}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground">{kindLabel(a)}</span>
                {a.locked && (
                  <Badge variant="outline" className="ml-2">
                    Locked
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-4 whitespace-nowrap">
                {a.className} {a.sectionName}
              </TableCell>
              <TableCell className="px-4">{a.subjectName}</TableCell>
              <TableCell className="px-4 text-right tabular-nums">{a.maxMarks}</TableCell>
              <TableCell className="px-4 text-right tabular-nums">{a.markedCount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {total > rows.length && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Showing the {rows.length} most recent of {total}. Filter by section to see others.
        </p>
      )}
    </div>
  );
}

const newTestSchema = z.object({
  sectionId: z.string().min(1, 'Choose a section.'),
  classSubjectId: z.string().min(1, 'Choose a subject.'),
  testType: z.enum(TEST_TYPES),
  name: nameSchema(1, 80),
  maxMarks: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{0,3}$/, 'Enter a whole number.')
    .refine((v) => Number(v) <= MAX_ASSESSMENT_MARKS, `At most ${MAX_ASSESSMENT_MARKS}.`),
  heldOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.'),
});
type NewTestValues = z.infer<typeof newTestSchema>;

const TYPE_OPTIONS = TEST_TYPES.map((value) => ({ value, label: TEST_TYPE_LABELS[value] }));

/** "New test" (§2.2): one of the caller's sections, a subject they teach there, keyed once per form. */
function NewTestForm({ sections, onDone }: { sections: MySection[]; onDone: () => void }) {
  const router = useRouter();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const form = useForm<NewTestValues>({
    resolver: zodResolver(newTestSchema),
    defaultValues: {
      sectionId: sections.length === 1 ? sections[0]!.sectionId : '',
      classSubjectId: '',
      testType: 'weekly',
      name: '',
      maxMarks: '20',
      heldOn: todayInSchool(),
    },
  });
  const sectionId = useWatch({ control: form.control, name: 'sectionId' });
  const section = sections.find((s) => s.sectionId === sectionId);
  const subjects = useQuery({
    queryKey: marksKeys.classSubjects(section?.classId ?? ''),
    queryFn: () =>
      unwrap(
        academics.GET('/api/v1/classes/{id}/subjects', {
          params: { path: { id: section!.classId }, query: { limit: 50 } },
        }),
      ),
    enabled: section !== undefined,
  });
  const subjectOptions = (subjects.data?.data ?? [])
    .filter((cs) => section?.subjectIds.includes(cs.subjectId))
    .map((cs) => ({ value: cs.id, label: cs.subjectName }));

  const save = useMutation({
    mutationFn: (values: NewTestValues) =>
      unwrap(
        assessmentsApi.POST('/api/v1/assessments', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            sectionId: values.sectionId,
            classSubjectId: values.classSubjectId,
            testType: values.testType as TestType,
            name: values.name,
            maxMarks: Number(values.maxMarks),
            heldOn: values.heldOn,
          },
        }),
      ),
    onSuccess: (created) => {
      toast.success(`${created.name} created.`);
      onDone();
      router.push(marksHref(created.id));
    },
    onError: (error) => {
      if (!applyApiFieldErrors(form, error))
        form.setError('root.server', { message: marksErrorMessage(error) });
    },
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit((values) => save.mutate(values))}
    >
      <DialogHeader>
        <DialogTitle>New test</DialogTitle>
        <DialogDescription>
          A class test in one of your sections, for a subject you teach there.
        </DialogDescription>
      </DialogHeader>
      <FormRootError form={form} />
      <FormField
        control={form.control}
        name="sectionId"
        label="Section"
        options={[
          { value: '', label: 'Choose…' },
          ...sections.map((s) => ({
            value: s.sectionId,
            label: `${s.className} ${s.sectionName}`,
          })),
        ]}
      />
      <FormField
        control={form.control}
        name="classSubjectId"
        label="Subject"
        disabled={!section}
        options={[
          { value: '', label: subjects.isFetching ? 'Loading…' : 'Choose…' },
          ...subjectOptions,
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField control={form.control} name="testType" label="Type" options={TYPE_OPTIONS} />
        <FormField control={form.control} name="heldOn" label="Held on" type="date" />
      </div>
      <FormField
        control={form.control}
        name="name"
        label="Name"
        maxLength={80}
        placeholder="Fractions weekly test"
      />
      <FormField control={form.control} name="maxMarks" label="Maximum marks" inputMode="numeric" />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Creating…' : 'Create test'}
        </Button>
      </DialogFooter>
    </form>
  );
}
