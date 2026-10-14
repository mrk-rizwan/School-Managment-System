/**
 * School API types for events and PTM (phase-5-extended.md slice 38, contracts/slice-38.md), taken
 * from the generated OpenAPI document (`school.d.ts`). Screens import the client and the DTO, body
 * and query types from here, so a regenerated document is checked against them by the typecheck.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as eventsApi } from './client';

export type EventDto = Schemas['EventDto'];
export type EventDutyDto = Schemas['EventDutyDto'];
export type EventSectionDto = Schemas['EventSectionDto'];
export type EventRosterDto = Schemas['EventRosterDto'];
export type EventRosterRowDto = Schemas['EventRosterRowDto'];
export type EventReportDto = Schemas['EventReportDto'];
export type EventSort = Schemas['EventSort'];
export type DutyKind = Schemas['DutyKind'];
export type ParticipationStatus = Schemas['ParticipationStatus'];

export type CreateEventBody = Schemas['CreateEventDto'];
export type UpdateEventBody = Schemas['UpdateEventDto'];
export type AddEventDutyBody = Schemas['AddEventDutyDto'];
export type RecordEventParticipationBody = Schemas['RecordEventParticipationDto'];
export type CreateEventPaymentBody = Schemas['CreateEventPaymentDto'];
export type EventListQuery = Query<'EventsController_list'>;

// ---- `details` of this slice's refusals (§2); error details are not in the OpenAPI document ----

/** 409 EVENT_PAYMENT_EXCEEDS_CHARGE: what the child still owes on the event charge. */
export type EventPaymentExceedsDetails = { eventId: string; outstanding: number };
/** 409 EVENT_DUTY_EXISTS: the live duty of that kind the member already holds. */
export type EventDutyExistsDetails = { eventId: string; dutyId: string };
