/**
 * School API types for announcements and the inbox (contracts/slice-14.md), taken from the
 * generated OpenAPI document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the
 * client and the DTO, body and query types from here, so a regenerated document is checked
 * against them by `pnpm typecheck`. The audience rules (`audiencesProblem`, `normaliseAudiences`,
 * the kind lists and limits, `AudienceInput`) come from `@asms/shared`, which the API runs too.
 * Section numbers below are the contract's.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as announcementsApi } from './client';

// ---- Enums (§2.1) ----

export type AnnouncementCategory = Schemas['AnnouncementCategory'];
export type AnnouncementPriority = Schemas['AnnouncementPriority'];
export type AnnouncementStatus = Schemas['AnnouncementStatus'];
export type AudienceKind = Schemas['AudienceKind'];
export type AudienceRole = Schemas['AudienceRole'];
export type InboxItemKind = Schemas['InboxItemKind'];
export type CapabilityScope = Schemas['CapabilityScope'];
/** §2.1: `suppression_reason` gains `duplicate_phone` in this slice. */
export type SuppressionReason = Schemas['SuppressionReason'];
export type AttachmentMime = Schemas['AttachmentMime'];
export type PreviewWarning = Schemas['AudiencePreviewWarning'];
export type AnnouncementSort = Schemas['AnnouncementSort'];

// ---- Shapes (§2.2, §8) ----

export type MeCapabilityScopeDto = Schemas['MeCapabilityScopeDto'];
export type AudienceDto = Schemas['AudienceDto'];
export type AnnouncementDto = Schemas['AnnouncementDto'];
export type AudiencePreviewDto = Schemas['AudiencePreviewDto'];
export type DeliveryChannelCounts = Schemas['ChannelCountsDto'];
export type DeliverySummaryDto = Schemas['DeliverySummaryDto'];
export type InboxItemDto = Schemas['InboxItemDto'];

// ---- Queries (§5.2, §7.3) ----

export type AnnouncementListQuery = NonNullable<operations['AnnouncementsController_list']['parameters']['query']>;
export type InboxQuery = NonNullable<operations['InboxController_list']['parameters']['query']>;

// ---- Bodies (§4.6, §5.4, §5.7, §5.8) ----

export type CreateAnnouncementBody = Schemas['CreateAnnouncementDto'];
/** Absent = unchanged; `scheduledAt`, `expiresOn`, `stagedUploadId: null` clear. */
export type UpdateAnnouncementBody = Schemas['UpdateAnnouncementDto'];
export type CancelAnnouncementBody = Schemas['CancelAnnouncementDto'];
export type PreviewAudienceBody = Schemas['PreviewAudienceDto'];

// ---- `details` of this slice's refusals (§9); error details are not in the OpenAPI document ----

/** 409 ANNOUNCEMENT_SENT from announcements.service.ts `sentRefusal`. */
export type AnnouncementSentDetails = { status: AnnouncementStatus };
/** 409 ANNOUNCEMENT_NO_RECIPIENTS from announcements.service.ts `send`: the number of audience items. */
export type AnnouncementNoRecipientsDetails = { audiences: number };
/** 409 SMS_TOO_LONG from announcement-dispatch.ts `assertSmsLength`. */
export type SmsTooLongDetails = { segments: number; maxSegments: number };
/** 409 SMS_CAP_EXCEEDED from announcements.service.ts `assertSmsCap`. */
export type SmsCapExceededDetails = { smsUnits: number; remaining: number; cap: number };
/** 409 GUARDIAN_MERGED from audiences.ts `refusal`; null when the survivor is not recorded. */
export type GuardianMergedDetails = { mergedIntoId: string | null };
/** 403 PERMISSION_DENIED from audiences.ts when a `.scope` sender picks a school-wide kind. */
export type AudienceRequiresSchoolDetails = { reason: 'audience_requires_school' };

// ---- Thumbnails: `<img src>`, cookie-authenticated, loaded on tap (§5.10, §7.5) ----

export const announcementThumbnailUrl = (id: string) => `/api/v1/announcements/${encodeURIComponent(id)}/thumbnail`;
export const inboxThumbnailUrl = (id: string) => `/api/v1/me/inbox/${encodeURIComponent(id)}/thumbnail`;
