/**
 * School API types for charges (phase-3-financial.md slice 19, contracts/slice-19.md): charges and
 * their corrections, generation runs, concessions, campaigns and the student's fee statement, taken
 * from the generated OpenAPI document (`school.d.ts`). Screens import from here so a regenerated
 * document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as chargesApi } from './client';

// ---- Enums ----

export type ChargeKind = Schemas['ChargeKind'];
export type ChargeStatus = Schemas['ChargeStatus'];
export type ChargeRunStatus = Schemas['ChargeRunStatus'];
export type ConcessionKind = Schemas['ConcessionKind'];
export type ConcessionStatus = Schemas['ConcessionStatus'];
export type CampaignStatus = Schemas['CampaignStatus'];
export type CampaignAudienceKind = Schemas['CampaignAudienceKind'];

// ---- Responses ----

export type ChargeDto = Schemas['ChargeDto'];
export type ChargeRunDto = Schemas['ChargeRunDto'];
export type ConcessionDto = Schemas['ConcessionDto'];
export type ConcessionDecisionDto = Schemas['ConcessionDecisionDto'];
export type CampaignDto = Schemas['CampaignDto'];
export type CampaignPreviewDto = Schemas['CampaignPreviewDto'];
export type StatementDto = Schemas['StatementDto'];

// ---- Queries ----

export type ChargeListQuery = Query<'ChargesController_list'>;
export type ChargeRunListQuery = Query<'ChargesController_listRuns'>;
export type ConcessionListQuery = Query<'ConcessionsController_list'>;
export type CampaignListQuery = Query<'CampaignsController_list'>;

// ---- Bodies ----

export type CampaignAudience = Schemas['CampaignAudienceDto'];

// ---- `details` of this slice's refusals; error details are not in the OpenAPI document ----

/** 409 CHARGE_NOT_OPEN on an adjustment above what is owed (until slice 20). */
/** `creditable` (slice 20): what is owed plus the paid money that can return to the family as an advance. */
export type ChargeNotOpen = { chargeId: string; reason?: 'exceeds_outstanding' | 'admission_head'; outstanding?: number; creditable?: number };
/** 409 MONTH_NOT_GENERATABLE. */
export type MonthNotGeneratable = { reason: 'future' | 'outside_year' | 'year_closed' };
/** 409 CHARGE_RUN_IN_PROGRESS. */
export type ChargeRunInProgress = { runId: string };
/** 409 CONCESSION_EXISTS. */
export type ConcessionExists = { concessionId: string; feeHeadId: string };
