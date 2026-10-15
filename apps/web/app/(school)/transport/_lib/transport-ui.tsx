'use client';

import { ErrorCode } from '@asms/shared';
import { AreaTabs } from '@/components/area-tabs';
import { Badge } from '@/components/ui/badge';
import { refusalMessage, type RefusalMessages } from '@/lib/api/errors';
import type { TransportAssignmentStatus } from '@/lib/api/school-transport-contract';

// Shared by the transport screens (contracts/slice-41.md §3): query keys, the area's tabs, the
// refusals in plain words and the status badges.

export const transportKeys = {
  all: ['school', 'transport'] as const,
  vehicles: (query: object) => ['school', 'transport', 'vehicles', query] as const,
  routes: (query: object) => ['school', 'transport', 'routes', query] as const,
  route: (id: string) => ['school', 'transport', 'route', id] as const,
  riders: (id: string, query: object) => ['school', 'transport', 'route', id, 'riders', query] as const,
  student: (id: string) => ['school', 'transport', 'student', id] as const,
};

export const routeHref = (id: string) => `/transport/${encodeURIComponent(id)}`;

const REFUSALS: RefusalMessages = {
  [ErrorCode.VEHICLE_REGISTRATION_TAKEN]: 'Another vehicle in use already has that registration.',
  [ErrorCode.VEHICLE_RETIRED]: 'That vehicle is retired.',
  [ErrorCode.VEHICLE_IN_USE]: 'A route still uses this vehicle. Give the route another vehicle first.',
  [ErrorCode.TRANSPORT_ROUTE_NAME_TAKEN]: 'Another route already has that name.',
  [ErrorCode.TRANSPORT_ROUTE_ARCHIVED]: 'This route is archived.',
  [ErrorCode.TRANSPORT_ROUTE_HAS_ASSIGNMENTS]: 'Students still ride this route. End their assignments first.',
  [ErrorCode.TRANSPORT_STOP_IN_USE]: 'A student is still assigned to a stop you removed. Move or end that student first.',
  [ErrorCode.TRANSPORT_ASSIGNMENT_LIVE]: 'Already on a route this year. End that assignment first.',
  [ErrorCode.TRANSPORT_AMOUNT_PERIOD_PAST]: 'A new amount starts next month or later; the current month keeps its amount.',
  [ErrorCode.TRANSPORT_AMOUNT_PERIOD_TAKEN]: 'The route already has an amount from that month. Void it first.',
  [ErrorCode.STALE_STATUS]: 'This changed meanwhile. Reload and try again.',
  [ErrorCode.CONCURRENT_UPDATE]: 'This changed meanwhile. Reload and try again.',
};
export const transportErrorMessage = (error: unknown): string => refusalMessage(error, REFUSALS);

const TABS = [
  { href: '/transport', label: 'Routes' },
  { href: '/transport/vehicles', label: 'Vehicles' },
] as const;

export function TransportTabs() {
  return <AreaTabs label="Transport" tabs={TABS} />;
}

const ASSIGNMENT_LABELS: Record<TransportAssignmentStatus, string> = { live: 'Riding', upcoming: 'Starts later', ended: 'Ended' };
const ASSIGNMENT_VARIANT = { live: 'secondary', upcoming: 'outline', ended: 'ghost' } as const satisfies Record<TransportAssignmentStatus, string>;

export function AssignmentStatusBadge({ status }: { status: TransportAssignmentStatus }) {
  return <Badge variant={ASSIGNMENT_VARIANT[status]}>{ASSIGNMENT_LABELS[status]}</Badge>;
}

/** "Link Road · 07:05", or "No stop chosen". */
export const stopLabel = (stopName: string | null, pickupTime: string | null) =>
  stopName ? [stopName, pickupTime].filter(Boolean).join(' · ') : 'No stop chosen';
