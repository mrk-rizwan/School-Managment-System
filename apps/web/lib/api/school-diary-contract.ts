/**
 * School API types for diary entries and remarks (contracts/slice-13.md), taken from the generated
 * OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client and
 * the DTO, body and query types from here, so a regenerated document is checked against them by
 * `pnpm typecheck`. Section numbers below are the contract's.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as diaryApi } from './client';

// ---- Enums ----

export type RemarkCategory = Schemas['RemarkCategory'];
export type RemarkVisibility = Schemas['RemarkVisibility'];
export type DiaryAttachmentMime = Schemas['AttachmentMime'];

// ---- Shapes (§2.2) ----

export type DiaryEntryDto = Schemas['DiaryEntryDto'];
export type RemarkDto = Schemas['RemarkDto'];

// ---- Bodies ----

export type CreateDiaryEntryBody = Schemas['CreateDiaryEntryDto'];
/** §4.4: absent = unchanged; null clears (not `topic`); `stagedUploadId: null` removes the attachment. */
export type UpdateDiaryEntryBody = Schemas['UpdateDiaryEntryDto'];
export type CreateRemarkBody = Schemas['CreateRemarkDto'];
export type CorrectRemarkBody = Schemas['CorrectRemarkDto'];

// ---- Queries ----

export type DiaryEntryQuery = NonNullable<operations['DiaryController_list']['parameters']['query']>;
export type RemarkQuery = NonNullable<operations['RemarksController_list']['parameters']['query']>;

// ---- `details` of this slice's refusals (§8); error details are not in the OpenAPI document ----

/**
 * 409 DIARY_ENTRY_EXISTS from diary-entries.service.ts `entryExists`; the unique-index fallback in
 * prisma-errors.ts sends no details, so callers read it as optional.
 */
export type DiaryEntryExistsDetails = { entryId: string };
/** 409 AMENDMENT_REASON_REQUIRED on a diary patch (diary-entries.service.ts `update`): the changed field names. */
export type DiaryAmendmentReasonRequiredDetails = { amendments: string[] };
/**
 * 409 REMARK_SUPERSEDED from remarks.service.ts `remarkSuperseded` (null when the successor is not
 * found); the unique-index fallback in prisma-errors.ts sends no details.
 */
export type RemarkSupersededDetails = { supersededById: string | null };
