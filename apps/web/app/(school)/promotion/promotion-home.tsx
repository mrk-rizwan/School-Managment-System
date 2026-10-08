'use client';

import { newIdempotencyKey } from '@asms/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { unwrap } from '@/lib/api/client';
import { academics, type AcademicYearDto } from '@/lib/api/school-academics-contract';
import { promotionApi, type PromotionSheetDto } from '@/lib/api/school-promotion-contract';
import { useYears } from '../academics/_lib/options';
import { useDefaultYearId, YearFilter } from '../reports/_lib/reports-ui';
import { promotionErrorMessage, promotionKeys, sheetHref } from './_lib/promotion-ui';

// contracts/slice-35.md: Promotion. Every section of the chosen year with its promotion sheet's
// state; a section without an open or applied sheet can be opened into a target year once its
// final result is approved. The year closes only when every section with students is applied.

/** Every page of a list (page size 50, the API's cap) until its total: a school may have more than 50 sections. */
async function allPages<T>(page: (n: number) => Promise<{ data: T[]; total: number }>): Promise<T[]> {
  const out: T[] = [];
  for (let n = 1; ; n++) {
    const { data, total } = await page(n);
    out.push(...data);
    if (data.length === 0 || out.length >= total) return out;
  }
}

/** The sheet a section shows: the open one, else the applied one, else the newest (cancelled). */
const sheetOf = (sheets: readonly PromotionSheetDto[], sectionId: string): PromotionSheetDto | null => {
  const own = sheets.filter((s) => s.sectionId === sectionId);
  return own.find((s) => s.status === 'open') ?? own.find((s) => s.status === 'applied') ?? own[0] ?? null;
};

interface SectionRow {
  sectionId: string;
  className: string;
  sectionName: string;
  sheet: PromotionSheetDto | null;
}

export function PromotionHome() {
  const [chosenYear, setChosenYear] = useState('');
  const yearId = useDefaultYearId(chosenYear);
  const [opening, setOpening] = useState<SectionRow | null>(null);
  const rows = useQuery({
    queryKey: promotionKeys.sections(yearId),
    queryFn: async (): Promise<SectionRow[]> => {
      const sheets = await allPages((page) =>
        unwrap(promotionApi.GET('/api/v1/promotion-sheets', { params: { query: { academicYearId: yearId, page, limit: 50 } } })),
      );
      const classes = await allPages((page) =>
        unwrap(academics.GET('/api/v1/classes', { params: { query: { academicYearId: yearId, page, limit: 50 } } })),
      );
      const out: SectionRow[] = [];
      for (const klass of classes) {
        const sections = await allPages((page) =>
          unwrap(
            academics.GET('/api/v1/classes/{id}/sections', { params: { path: { id: klass.id }, query: { page, limit: 50 } } }),
          ),
        );
        for (const section of sections) {
          out.push({ sectionId: section.id, className: klass.name, sectionName: section.name, sheet: sheetOf(sheets, section.id) });
        }
      }
      return out;
    },
    enabled: yearId !== '',
  });
  return (
    <>
      <PageHeader
        title="Promotion"
        description="At year end each section's final result proposes promote, detain or complete; apply the sheet to move students into the next year."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <YearFilter value={yearId} onChange={setChosenYear} />
      </div>
      <QueryStates query={rows} loadingRows={6}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState title="No sections" description="This academic year has no classes or sections." />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4">Section</TableHead>
                    <TableHead>Promotion sheet</TableHead>
                    <TableHead>Into</TableHead>
                    <TableHead className="text-right">Students</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((row) => (
                    <TableRow key={row.sectionId}>
                      <TableCell className="px-4 font-medium">
                        {row.className} {row.sectionName}
                      </TableCell>
                      <TableCell>
                        {row.sheet === null ? (
                          <span className="text-muted-foreground">Not opened</span>
                        ) : row.sheet.status === 'applied' ? (
                          <Badge variant="secondary">Applied</Badge>
                        ) : row.sheet.status === 'cancelled' ? (
                          <Badge variant="outline">Cancelled</Badge>
                        ) : (
                          <Badge variant="outline">
                            Open{row.sheet.undecided > 0 ? ` · ${row.sheet.undecided} undecided` : ''}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{row.sheet?.targetYearName ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.sheet?.rows ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        {row.sheet !== null && (
                          <Link href={sheetHref(row.sheet.id)} className="mr-3 text-sm font-medium hover:underline">
                            View
                          </Link>
                        )}
                        {row.sheet?.status !== 'open' && row.sheet?.status !== 'applied' && (
                          <Button variant="outline" size="sm" onClick={() => setOpening(row)}>
                            Open sheet
                          </Button>
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
      {opening && <OpenSheetDialog yearId={yearId} row={opening} onClose={() => setOpening(null)} />}
    </>
  );
}

/** The years a sheet may promote into: planned or active, not this one; the next by start first. */
function targetYears(years: readonly AcademicYearDto[], yearId: string): AcademicYearDto[] {
  const current = years.find((y) => y.id === yearId);
  return years
    .filter((y) => y.id !== yearId && y.status !== 'closed')
    .sort((a, b) => {
      const after = (y: AcademicYearDto) => (current && y.startsOn > current.startsOn ? 0 : 1);
      return after(a) - after(b) || a.startsOn.localeCompare(b.startsOn);
    });
}

function OpenSheetDialog({ yearId, row, onClose }: { yearId: string; row: SectionRow; onClose: () => void }) {
  const router = useRouter();
  const years = useYears();
  const choices = targetYears(years.data?.data ?? [], yearId);
  const [chosen, setChosen] = useState('');
  const targetYearId = chosen || (choices[0]?.id ?? '');
  // One key per opened dialog: a retried confirm replays, never opens twice.
  const [key] = useState(newIdempotencyKey);
  const open = useMutation({
    mutationFn: () =>
      unwrap(
        promotionApi.POST('/api/v1/sections/{id}/promotion-sheets', {
          params: { path: { id: row.sectionId }, header: { 'Idempotency-Key': key } },
          body: { targetYearId },
        }),
      ),
    onSuccess: (sheet) => router.push(sheetHref(sheet.id)),
  });
  const fieldId = useId();
  return (
    <Dialog open onOpenChange={(next) => (next || open.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Open the promotion sheet of {row.className} {row.sectionName}
          </DialogTitle>
          <DialogDescription>
            Proposals come from the approved final result. The next year, its classes and each class&apos;s
            next class must exist first.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={fieldId}>Promote into</Label>
          <NativeSelect id={fieldId} value={targetYearId} onChange={(e) => setChosen(e.target.value)}>
            {choices.length === 0 && <option value="">No planned or active year</option>}
            {choices.map((y) => (
              <option key={y.id} value={y.id}>
                {y.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {choices.length === 0 && !years.isPending && (
          <p className="text-sm text-muted-foreground">
            Create the next academic year under Academic structure first.
          </p>
        )}
        {open.error && (
          <Alert variant="destructive">
            <AlertDescription>{promotionErrorMessage(open.error)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={open.isPending}>
            Cancel
          </Button>
          <Button onClick={() => open.mutate()} disabled={!targetYearId || open.isPending}>
            {open.isPending ? 'Opening…' : 'Open sheet'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
