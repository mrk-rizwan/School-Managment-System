'use client';

import { DEFAULT_TIMEZONE, type SchoolStatus } from '@asms/shared';
import { useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { FormFieldOption } from '@/components/form-field';
import { Badge } from '@/components/ui/badge';

// Pieces shared by the school list, create and detail screens.

/** School name rule of contract §4.2 (2–200, no control characters), shared by create and edit. */
export const schoolNameSchema = z
  .string()
  .trim()
  .min(2, 'Use at least 2 characters.')
  .max(200, 'Use at most 200 characters.')
  .regex(/^\P{Cc}*$/u, 'Remove line breaks and control characters.');

export const SCHOOL_STATUS_LABELS: Record<SchoolStatus, string> = {
  trial: 'Trial',
  active: 'Active',
  suspended: 'Suspended',
  terminated: 'Terminated',
};

const STATUS_VARIANT = {
  trial: 'outline',
  active: 'secondary',
  suspended: 'destructive',
  terminated: 'destructive',
} as const satisfies Record<SchoolStatus, string>;

export function SchoolStatusBadge({ status }: { status: SchoolStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{SCHOOL_STATUS_LABELS[status]}</Badge>;
}

// Dates are shown in Pakistan time (CLAUDE.md: Asia/Karachi is assumed for every school). A
// fixed zone also keeps the server render and the browser render identical.
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: DEFAULT_TIMEZONE,
});
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: DEFAULT_TIMEZONE,
});
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

// Time-zone options come from the browser (contracts/slice-1.md §8). The server render uses
// only the default so it cannot disagree with the browser's list during hydration.
let browserZones: readonly string[] | null = null;
const subscribe = () => () => {};
const getZones = () => (browserZones ??= Intl.supportedValuesOf('timeZone'));
const SERVER_ZONES: readonly string[] = [DEFAULT_TIMEZONE];
const getServerZones = () => SERVER_ZONES;

/** Time-zone select options; `current` is always included, even if this browser lacks it. */
export function useTimezoneOptions(current?: string): FormFieldOption[] {
  const zones = useSyncExternalStore(subscribe, getZones, getServerZones);
  return useMemo(() => {
    const all = new Set(zones);
    all.add(DEFAULT_TIMEZONE);
    if (current) all.add(current);
    return [...all].sort().map((zone) => ({ value: zone, label: zone.replaceAll('_', ' ') }));
  }, [zones, current]);
}
