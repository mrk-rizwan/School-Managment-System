/**
 * School API types for the staff screens (contracts/slice-4.md), taken from the generated OpenAPI
 * document (`school.d.ts`, produced by `pnpm api:generate`). Screens import the client and the
 * DTO, body and query types from here, so a regenerated document is checked against them by
 * `pnpm typecheck`.
 */
import type { components, operations } from './school';

type Schemas = components['schemas'];

export { schoolApi as staffApi } from './client';

/** contracts/slice-2.md §5 — the response of issue-login. */
export type { UserDto } from './school-contract';

// ---- Enums (contract §2) ----

export type StaffStatus = Schemas['StaffStatus'];
export type SystemRole = Schemas['SystemRole'];
export type TeacherRole = Schemas['TeacherRole'];

// ---- Responses (contract §2) ----

export type Paginated<T> = { data: T[]; page: number; limit: number; total: number };

export type StaffDto = Schemas['StaffDto'];
export type TeacherAssignmentDto = Schemas['TeacherAssignmentDto'];
export type UserRoleDto = Schemas['UserRoleDto'];

// ---- Queries ----

export type StaffSort = Schemas['StaffSort'];
export type StaffListQuery = NonNullable<operations['StaffController_list']['parameters']['query']>;
export type TeacherAssignmentSort = Schemas['TeacherAssignmentSort'];
export type TeacherAssignmentListQuery = NonNullable<
  operations['StaffController_listAssignments']['parameters']['query']
>;
export type UserRoleListQuery = NonNullable<
  operations['UserRolesController_list']['parameters']['query']
>;

// ---- Bodies ----

export type CreateStaffBody = Schemas['CreateStaffDto'];
/** Absent = unchanged, null = clear (not allowed for fullName and phone). `cnic` is 409 STAFF_CNIC_LOCKED once a login exists. */
export type UpdateStaffBody = Schemas['UpdateStaffDto'];
export type ChangeStaffStatusBody = Schemas['ChangeStaffStatusDto'];
export type IssueStaffLoginBody = Schemas['IssueStaffLoginDto'];
export type CreateTeacherAssignmentBody = Schemas['CreateTeacherAssignmentDto'];
export type EndTeacherAssignmentBody = Schemas['EndTeacherAssignmentDto'];
export type AssignRoleBody = Schemas['AssignRoleDto'];
export type ReasonBody = Schemas['RemoveRoleDto'];

/** `details` of 409 CLASS_TEACHER_EXISTS (§4.3); error details are not in the OpenAPI document. */
export type ClassTeacherConflict = {
  assignmentId: string;
  staffId: string;
  staffFullName: string;
  startsOn: string;
  endsOn: string | null;
};
