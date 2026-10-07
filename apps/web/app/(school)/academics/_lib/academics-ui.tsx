'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { toast } from 'sonner';
import { ConfirmWithReasonDialog } from '@/components/confirm-with-reason-dialog';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { ApiError, toastApiError } from '@/lib/api/errors';
import type {
  AcademicYearStatus,
  AttendanceMode,
} from '@/lib/api/school-academics-contract';
import { cn } from '@/lib/utils';

// Pieces shared by the four academic-structure tabs (contracts/slice-3.md §8).

export const academicsKeys = {
  all: ['school', 'academics'] as const,
  years: ['school', 'academics', 'years'] as const,
  classes: ['school', 'academics', 'classes'] as const,
  class: (id: string) => ['school', 'academics', 'classes', 'detail', id] as const,
  sections: (classId: string) => ['school', 'academics', 'sections', classId] as const,
  subjects: ['school', 'academics', 'subjects'] as const,
  // Phase 4 slice 29.
  terms: (yearId: string) => ['school', 'academics', 'terms', yearId] as const,
  resultSettings: (yearId: string) => ['school', 'academics', 'result-settings', yearId] as const,
  classSubjects: (classId: string) => ['school', 'academics', 'class-subjects', classId] as const,
};

export const YEAR_STATUS_LABELS: Record<AcademicYearStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  closed: 'Closed',
};
const YEAR_STATUS_VARIANT = {
  planned: 'outline',
  active: 'secondary',
  closed: 'ghost',
} as const satisfies Record<AcademicYearStatus, string>;

export function YearStatusBadge({ status }: { status: AcademicYearStatus }) {
  return <Badge variant={YEAR_STATUS_VARIANT[status]}>{YEAR_STATUS_LABELS[status]}</Badge>;
}

/** Shown for an archived class, section or subject. */
export function ArchivedBadge() {
  return <Badge variant="ghost">Archived</Badge>;
}

export const ATTENDANCE_MODE_LABELS: Record<AttendanceMode, string> = {
  daily: 'Once a day',
  period: 'Every period',
};

const TABS = [
  { href: '/academics/years', label: 'Academic years' },
  { href: '/academics/classes', label: 'Classes' },
  { href: '/academics/subjects', label: 'Subjects' },
  { href: '/academics/terms', label: 'Terms and results' },
] as const;

/** Sections live under their class (class detail), so they have no tab of their own. */
export function AcademicsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Academic structure" className="mb-6 flex gap-1 border-b">
      {TABS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Archive a class, section or subject through the shared confirm-with-reason dialog. The reason
 * is optional (3–500 characters when given, §3.5), so an empty box is accepted and nothing is
 * sent. Archiving cannot be undone in v1.
 */
export function ArchiveDialog({
  target,
  onClose,
  noun,
  archive,
  onArchived,
}: {
  /** The row's display name, or null when the dialog is closed. */
  target: string | null;
  onClose: () => void;
  noun: string;
  archive: (reason: string | undefined) => Promise<unknown>;
  onArchived: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (reason: string) => archive(reason || undefined),
    onSuccess: () => {
      toast.success(`${target} archived.`);
      onArchived();
      onClose();
    },
    onError: (error) => {
      toastApiError(error);
      // A refusal from the record's state (it changed meanwhile): show the current rows.
      if (error instanceof ApiError && error.status === 409) {
        onArchived();
        onClose();
      }
    },
  });
  return (
    <ConfirmWithReasonDialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={`Archive ${noun}: ${target ?? ''}`}
      description={`An archived ${noun} keeps its history but cannot be edited or restored. A reason is optional.`}
      confirmLabel="Archive"
      minLength={0}
      maxLength={500}
      destructive
      pending={mutation.isPending}
      onConfirm={(reason) => mutation.mutate(reason)}
    />
  );
}

/** The "Show archived" toggle of the classes, sections and subjects tables. */
export function ShowArchivedToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex h-8 items-center gap-2">
      <input
        id={id}
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <Label htmlFor={id}>Show archived</Label>
    </div>
  );
}
