/**
 * School API types for the slice-6 screens (contracts/slice-6.md): students, guardian links,
 * enrolments, documents, uploads and admission. Taken from the generated OpenAPI document
 * (`school.d.ts`, produced by `pnpm api:generate`), so a regenerated document is checked against
 * the screens by `pnpm typecheck`. The enum value lists live in @asms/shared.
 *
 * POST /uploads is typed `{ file: string }` (multipart); the screens pass FormData with a cast,
 * which openapi-fetch sends as is. The file endpoints are read with `parseAs: 'blob'`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as studentsApi } from './client';

export type { UserDto } from './school-contract';

// ---- Enums (contract §2); the value lists are in @asms/shared ----

export type StudentStatus = Schemas['StudentStatus'];
export type Gender = Schemas['Gender'];
export type Relationship = Schemas['Relationship'];
export type EnrolmentStatus = Schemas['EnrolmentStatus'];
export type DocumentType = Schemas['DocumentType'];
export type DocumentMime = Schemas['DocumentMime'];

// ---- Responses (§2) ----

export type StudentCurrentDto = Schemas['StudentCurrentEnrolmentDto'];
export type StudentDto = Schemas['StudentDto'];
export type StudentDetailDto = Schemas['StudentDetailDto'];
export type GuardianLinkDto = Schemas['GuardianLinkDto'];
export type EnrolmentDto = Schemas['EnrolmentDto'];
export type StatusChangeDto = Schemas['StatusChangeDto'];
export type StudentDocumentDto = Schemas['StudentDocumentDto'];
export type StagedUploadDto = Schemas['StagedUploadDto'];
export type StudentLookupResultDto = Schemas['StudentLookupResultDto'];
export type AdmissionResultDto = Schemas['AdmissionResultDto'];

/** `details.matches[]` of 409 ADMISSION_POSSIBLE_DUPLICATE; error details are not in the OpenAPI document. */
export type DuplicateMatchDto = {
  studentId: string;
  admissionNo: string;
  fullName: string;
  dateOfBirth: string;
  status: StudentStatus;
  className: string | null;
};

// ---- Queries ----

export type StudentSort = Schemas['StudentSort'];
export type StudentListQuery = NonNullable<operations['StudentsController_list']['parameters']['query']>;

// ---- Bodies ----

export type UpdateStudentBody = Schemas['UpdateStudentDto'];
export type UpdateGuardianLinkBody = Schemas['UpdateGuardianLinkDto'];

/**
 * The API requires exactly one of `guardianId` and `newGuardian` (§6.2); the generated type has
 * both optional, so the screens use this narrower union, which is assignable to it.
 */
type GuardianLinkFlags = Omit<Schemas['AdmissionGuardianDto'], 'guardianId' | 'newGuardian'>;
type AdmissionGuardianBody =
  | (GuardianLinkFlags & { guardianId: string; newGuardian?: never })
  | (GuardianLinkFlags & { newGuardian: Schemas['CreateGuardianDto']; guardianId?: never });
export type AdmissionBody = Omit<Schemas['CreateAdmissionDto'], 'guardians'> & {
  guardians: AdmissionGuardianBody[];
};
