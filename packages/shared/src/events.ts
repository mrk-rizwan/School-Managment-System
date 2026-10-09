/**
 * Events and PTM value sets (Phase 5 rule 34, phase-5-extended.md §1.1, §3.2), for the API's DTOs
 * and the clients. Each mirrors the Postgres enum of the same name (migration
 * 20261009120100_phase5_groundwork); test/guardrails/shared-enums.e2e-spec.ts compares them.
 */

/** `events.type`. PTM has no per-parent slot booking (rule 34). */
export const EVENT_TYPES = ['ptm', 'trip', 'sports_day', 'function', 'visit', 'meeting', 'other'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_LABELS: Readonly<Record<EventType, string>> = {
  ptm: 'Parent-teacher meeting',
  trip: 'Trip',
  sports_day: 'Sports day',
  function: 'Function',
  visit: 'Visit',
  meeting: 'Meeting',
  other: 'Other',
};

/** draft -> published | cancelled; published -> completed | cancelled (§3.2). */
export const EVENT_STATUSES = ['draft', 'published', 'completed', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** `event_duties.duty`: each officer sees only their own (rule 34). */
export const DUTY_KINDS = ['registration', 'supervision', 'collection', 'transport', 'other'] as const;
export type DutyKind = (typeof DUTY_KINDS)[number];

/** `event_participation.status`, recorded per student (A5). */
export const PARTICIPATION_STATUSES = ['attended', 'absent', 'excused'] as const;
export type ParticipationStatus = (typeof PARTICIPATION_STATUSES)[number];
