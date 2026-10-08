'use client';

import { Capability, RESULT_SHEET_STATUSES } from '@asms/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, QueryStates } from '@/components/page-states';
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
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
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
  resultsApi,
  type ResultSheetListQuery,
  type ResultSheetStatus,
} from '@/lib/api/school-results-contract';
import { formatDateTime, todayInSchool } from '@/lib/format';
import { useCapabilities, useSchoolMe } from '@/lib/school-session';
import { mySections } from '../../attendance/_lib/attendance-ui';
import { useDefaultYearId, YearFilter } from '../../reports/_lib/reports-ui';
import {
  resultErrorMessage,
  resultKeys,
  sheetHref,
  SHEET_STATUS_LABELS,
  sheetStatusVariant,
  sheetTermLabel,
} from '../_lib/results-ui';

// contracts/slice-31.md §9: Results → Sheets. The sheets the caller reads (their own sections as
// class teacher or cover; the school with marks.view_all or result.approve), filtered by term and
// status; "Open a sheet" for a section they may author, which creates it (or opens the open one).

export function ResultsHome() {
  const [chosenYear, setChosenYear] = useState('');
  const yearId = useDefaultYearId(chosenYear);
  const [termId, setTermId] = useState('');
  const [status, setStatus] = useState<ResultSheetStatus | ''>('');
  const [opening, setOpening] = useState(false);
  const terms = useTerms(yearId);
  const query: ResultSheetListQuery = {
    limit: 50,
    ...(termId === 'final' ? { final: 'true' } : termId ? { termId } : {}),
    ...(status ? { status } : {}),
  };
  const list = useQuery({
    queryKey: resultKeys.list(query),
    queryFn: () => unwrap(resultsApi.GET('/api/v1/result-sheets', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const termFilterId = useId();
  const statusFilterId = useId();
  return (
    <>
      <PageHeader
        title="Result sheets"
        description="A section's term result: the class teacher submits it, the principal approves and publishes it."
        actions={
          <Button onClick={() => setOpening(true)}>
            <PlusIcon aria-hidden />
            Open a sheet
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <YearFilter value={yearId} onChange={setChosenYear} />
        <div className="grid w-full gap-1.5 sm:w-44">
          <Label htmlFor={termFilterId}>Term</Label>
          <NativeSelect
            id={termFilterId}
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
          >
            <option value="">All terms</option>
            {(terms.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="final">Final result</option>
          </NativeSelect>
        </div>
        <div className="grid w-full gap-1.5 sm:w-52">
          <Label htmlFor={statusFilterId}>Status</Label>
          <NativeSelect
            id={statusFilterId}
            value={status}
            onChange={(e) => setStatus(e.target.value as ResultSheetStatus | '')}
          >
            <option value="">Any status</option>
            {RESULT_SHEET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {SHEET_STATUS_LABELS[s]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <QueryStates query={list} loadingRows={6}>
        {(page) =>
          page.data.length === 0 ? (
            <EmptyState
              title="No result sheets"
              description="A class teacher opens the section's sheet once the term's marks are in."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4">Section</TableHead>
                    <TableHead>Term</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Submitted</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.data.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="px-4 font-medium">
                        <Link href={sheetHref(s.id)} className="hover:underline">
                          {s.className} {s.sectionName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {sheetTermLabel(s)}
                        {s.version > 1 && (
                          <span className="ml-1 text-xs text-muted-foreground">v{s.version}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={sheetStatusVariant(s.status)}>
                          {SHEET_STATUS_LABELS[s.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {s.submittedAt
                          ? `${formatDateTime(s.submittedAt)} · ${s.submittedByName ?? ''}`
                          : '—'}
                      </TableCell>
                      <TableCell className="space-x-1">
                        {s.cover && <Badge variant="outline">Cover</Badge>}
                        {s.selfApproved && <Badge variant="outline">Self-approved</Badge>}
                        {s.ownChildFlags.length > 0 && (
                          <Badge variant="destructive">Own child</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </QueryStates>
      {opening && <OpenSheetDialog yearId={yearId} onClose={() => setOpening(false)} />}
    </>
  );
}

function useTerms(yearId: string) {
  return useQuery({
    queryKey: resultKeys.terms(yearId),
    queryFn: async () =>
      (
        await unwrap(
          academics.GET('/api/v1/academic-years/{id}/terms', {
            params: { path: { id: yearId }, query: { limit: 10 } },
          }),
        )
      ).data,
    enabled: yearId !== '',
  });
}

/**
 * Opens a section's sheet: POST /sections/:id/result-sheets (201 new, 200 the open one), then the
 * sheet. The sections offered are those the caller class-teaches or covers today; an
 * assessment.define holder also picks any section of the year.
 */
function OpenSheetDialog({ yearId, onClose }: { yearId: string; onClose: () => void }) {
  const router = useRouter();
  const me = useSchoolMe();
  const { can } = useCapabilities();
  const terms = useTerms(yearId);
  const mine = mySections(me.data, todayInSchool()).filter(
    (s) => s.roles.includes('class_teacher') || s.roles.includes('cover'),
  );
  const define = can(Capability.ASSESSMENT_DEFINE);
  const classes = useQuery({
    queryKey: ['result-sheets', 'classes', yearId],
    queryFn: async () => {
      const page = await unwrap(
        academics.GET('/api/v1/classes', {
          params: { query: { academicYearId: yearId, status: 'active', limit: 50 } },
        }),
      );
      const rows: { sectionId: string; label: string }[] = [];
      for (const klass of page.data) {
        const sections = await unwrap(
          academics.GET('/api/v1/classes/{id}/sections', {
            params: { path: { id: klass.id }, query: { limit: 50 } },
          }),
        );
        for (const section of sections.data)
          rows.push({ sectionId: section.id, label: `${klass.name} ${section.name}` });
      }
      return rows;
    },
    enabled: define && yearId !== '',
  });
  const choices = define
    ? (classes.data ?? [])
    : mine.map((s) => ({ sectionId: s.sectionId, label: `${s.className} ${s.sectionName}` }));
  const [sectionId, setSectionId] = useState('');
  const [termId, setTermId] = useState('');
  const open = useMutation({
    mutationFn: () =>
      unwrap(
        resultsApi.POST('/api/v1/sections/{id}/result-sheets', {
          params: { path: { id: sectionId } },
          body: { termId: termId === 'final' ? null : termId },
        }),
      ),
    onSuccess: (sheet) => router.push(sheetHref(sheet.id)),
  });
  const sectionFieldId = useId();
  const termFieldId = useId();
  return (
    <Dialog open onOpenChange={(next) => (next || open.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a result sheet</DialogTitle>
          <DialogDescription>
            Choose the section and the term. An open sheet is reopened, not duplicated.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={sectionFieldId}>Section</Label>
            <NativeSelect
              id={sectionFieldId}
              value={sectionId}
              onChange={(e) => setSectionId(e.target.value)}
            >
              <option value="">Choose a section</option>
              {choices.map((c) => (
                <option key={c.sectionId} value={c.sectionId}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={termFieldId}>Term</Label>
            <NativeSelect
              id={termFieldId}
              value={termId}
              onChange={(e) => setTermId(e.target.value)}
            >
              <option value="">Choose a term</option>
              {(terms.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value="final">Final result (the year)</option>
            </NativeSelect>
          </div>
          {choices.length === 0 && !classes.isPending && (
            <p className="text-sm text-muted-foreground">
              You are not the class teacher of a section today.
            </p>
          )}
          {open.error && (
            <Alert variant="destructive">
              <AlertDescription>{resultErrorMessage(open.error)}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={open.isPending}>
            Cancel
          </Button>
          <Button onClick={() => open.mutate()} disabled={!sectionId || !termId || open.isPending}>
            Open sheet
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
