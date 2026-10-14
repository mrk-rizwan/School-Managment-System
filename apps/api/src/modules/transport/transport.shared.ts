import { toDateString } from '../academics/academics.shared';
import { timeOfDay } from '../../common/school-settings-reader';
import type { RouteAmountRecord, StopRecord } from '../../repositories/transport.repository';
import type { TransportRouteAmountDto, TransportStopDto } from './transport.dto';

// Phase 5 slice 41 (contracts/slice-41.md): the small pure helpers both transport services share.

/** `YYYY-MM` of a calendar date. */
export const periodOfDay = (day: Date): string => toDateString(day).slice(0, 7);

/** The `YYYY-MM` after `period`. */
export function nextPeriod(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** `HH:MM` as a TIME column value (1970-01-01 UTC). */
export const timeColumn = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);

export const toStopDto = (s: StopRecord): TransportStopDto => ({
  id: s.id.toString(),
  sortOrder: s.sortOrder,
  name: s.name,
  pickupTime: s.pickupTime === null ? null : timeOfDay(s.pickupTime),
});

/** A void is allowed for a live amount whose period has not started (the database's rule too). */
export const toAmountDto = (a: RouteAmountRecord, currentPeriod: string): TransportRouteAmountDto => ({
  id: a.id.toString(),
  routeId: a.routeId.toString(),
  effectivePeriod: a.effectivePeriod,
  amount: a.amount,
  createdByName: a.createdByName,
  createdAt: a.createdAt,
  voidedAt: a.voidedAt,
  voidReason: a.voidReason,
  voidable: a.voidedAt === null && a.effectivePeriod > currentPeriod,
});

/**
 * The amount in force for `period` (the live row with the greatest effective period not after
 * it) and the next live one after it — `amounts` newest period first.
 */
export function amountsAround(
  amounts: readonly RouteAmountRecord[],
  period: string,
): { current: number | null; next: { amount: number; effectivePeriod: string } | null } {
  const live = amounts.filter((a) => a.voidedAt === null);
  const current = live.find((a) => a.effectivePeriod <= period) ?? null;
  const later = live.filter((a) => a.effectivePeriod > period);
  const next = later.length === 0 ? null : (later[later.length - 1] ?? null);
  return {
    current: current?.amount ?? null,
    next: next === null ? null : { amount: next.amount, effectivePeriod: next.effectivePeriod },
  };
}
