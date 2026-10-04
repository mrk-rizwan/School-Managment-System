import type { components } from './school';

// The DTO and body types the screens use, from the generated document (slice-15 §2.5). A
// regenerated document that changes one of these is caught by `pnpm typecheck`.
type Schemas = components['schemas'];

export type MeDto = Schemas['MeDto'];
export type LoginResultDto = Schemas['LoginResultDto'];
export type MeAssignmentDto = Schemas['MeAssignmentDto'];
export type DeviceDto = Schemas['DeviceDto'];
/** The contract calls it MeCalendarDto; the generated document names it MyCalendarDto. */
export type MyCalendarDto = Schemas['MyCalendarDto'];
export type SchoolLoginDto = Schemas['SchoolLoginDto'];
export type RegisterDeviceDto = Schemas['RegisterDeviceDto'];
export type ChangePasswordDto = Schemas['ChangePasswordDto'];
export type SessionsRevokedDto = Schemas['SessionsRevokedDto'];
