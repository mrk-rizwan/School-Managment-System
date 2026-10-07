/**
 * School API types for deposit claims and the guardian's fees (phase-3-financial.md slice 21,
 * contracts/slice-21.md): the office's claim queue and the guardian's dues, receipts, claims and
 * upload, taken from the generated OpenAPI document (`school.d.ts`). Screens import from here so a
 * regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './school';
import { schoolApi } from './client';
import { unwrap } from './client';

type Schemas = components['schemas'];
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>;

export { schoolApi as claimsApi } from './client';

export type ClaimStatus = Schemas['ClaimStatus'];
export type DepositMethod = Schemas['DepositMethod'];
export type ClaimDto = Schemas['ClaimDto'];
export type VerifiedClaimDto = Schemas['VerifiedClaimDto'];
export type VerifyClaimBody = Schemas['VerifyClaimDto'];
export type ClaimListQuery = Query<'PaymentClaimsController_list'>;

export type MyDuesDto = Schemas['MyDuesDto'];
export type MyChargeDto = Schemas['MyChargeDto'];
export type MyReceiptDto = Schemas['MyReceiptDto'];
export type MyClaimDto = Schemas['MyClaimDto'];
export type StagedUploadDto = Schemas['StagedUploadDto'];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  pending: 'Waiting for the office',
  verified: 'Verified',
  rejected: 'Not accepted',
  withdrawn: 'Withdrawn',
  expired: 'Expired (no slip)',
};

/** `<img src>` of a slip: streamed with the session cookie, loaded on tap only (R198). */
export const claimImageUrl = (claimId: string, thumbnail = false): string =>
  `/api/v1/payment-claims/${claimId}/${thumbnail ? 'thumbnail' : 'image'}`;
export const myClaimImageUrl = (studentId: string, claimId: string, thumbnail = false): string =>
  `/api/v1/me/children/${studentId}/payment-claims/${claimId}/${thumbnail ? 'thumbnail' : 'image'}`;

/** POST /me/uploads, multipart with the one field `file`: the guardian's slip (R199). */
export function uploadSlip(file: File): Promise<StagedUploadDto> {
  const body = new FormData();
  body.append('file', file);
  // The generated body type is { file: string }; openapi-fetch sends FormData as is.
  return unwrap(schoolApi.POST('/api/v1/me/uploads', { body: body as unknown as { file: string } }));
}
