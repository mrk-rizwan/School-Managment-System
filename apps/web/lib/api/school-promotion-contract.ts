/**
 * School API types for promotion and year end (contracts/slice-35.md), taken from the generated
 * OpenAPI document (`school.d.ts`). Screens import the client and the DTO, body and query types
 * from here, so a regenerated document is checked against them by the typecheck.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as promotionApi } from './client';

export type PromotionOutcome = Schemas['PromotionOutcome'];
export type PromotionSheetStatus = Schemas['PromotionSheetStatus'];
export type PromotionSheetDto = Schemas['PromotionSheetDto'];
export type PromotionSheetDetailDto = Schemas['PromotionSheetDetailDto'];
export type PromotionDecisionDto = Schemas['PromotionDecisionDto'];
export type PromotionDecisionInput = Schemas['PromotionDecisionInputDto'];
export type PromotionSheetListQuery = NonNullable<
  operations['PromotionController_list']['parameters']['query']
>;
