import { formatDay } from '@asms/shared';
import type { MyDriverRouteDto, MyTransportDto } from '../api/contracts';

// Transport on the phone (Phase 5 slice 41, contracts/slice-41.md §3): the pure parts of the
// family's route card and the driver's route list. No React, no I/O.

type Current = NonNullable<MyTransportDto['current']>;

/** "Link Road · pickup 07:05", "Link Road", or null when no stop is chosen yet. */
export function stopLine(c: Pick<Current, 'stopName' | 'pickupTime'>): string | null {
  if (c.stopName === null) return null;
  return c.pickupTime === null ? c.stopName : `${c.stopName} · pickup ${c.pickupTime}`;
}

/** "From 1 Apr 2026", "From 1 Apr 2026 to 30 Jun 2026", or "Starts 1 Nov 2026" when later. */
export function spanLine(c: Pick<Current, 'startsOn' | 'endsOn'>, today: string): string {
  const from = c.startsOn > today ? `Starts ${formatDay(c.startsOn)}` : `From ${formatDay(c.startsOn)}`;
  return c.endsOn === null ? from : `${from} to ${formatDay(c.endsOn)}`;
}

/** A driver's route as stops in order, each with the riders who board there; riders with no stop last. */
export function boardings(route: MyDriverRouteDto): { title: string; detail: string | null; names: string[] }[] {
  const byStop = route.stops.map((s) => ({
    title: s.name,
    detail: s.pickupTime,
    names: route.students.filter((r) => r.stopId === s.id).map((r) => r.name),
  }));
  const loose = route.students.filter((r) => r.stopId === null || !route.stops.some((s) => s.id === r.stopId)).map((r) => r.name);
  return loose.length === 0 ? byStop : [...byStop, { title: 'No stop chosen', detail: null, names: loose }];
}

/** "3 riders", "1 rider". */
export const ridersLine = (route: MyDriverRouteDto): string =>
  `${route.students.length} ${route.students.length === 1 ? 'rider' : 'riders'}`;
