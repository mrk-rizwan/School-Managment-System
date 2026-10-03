/**
 * Platform API types for the messaging knobs on a school, platform settings and delivery health
 * (contracts/slice-9.md §2.2, §6), taken from the generated OpenAPI document (`platform.d.ts`,
 * produced by `pnpm api:generate`). Screens import the client and the DTO, body and query types
 * from here, so a regenerated document is checked against them by `pnpm typecheck`.
 */
import type { components, operations } from './platform';

type Schemas = components['schemas'];

export { platformApi as platformMessagingApi } from './client';

// ---- Enums ----

export type WhatsAppProvider = Schemas['WhatsAppProvider'];
export type WhatsAppProviderChoice = Schemas['WhatsAppProviderChoice'];
export type SmsProvider = Schemas['SmsProvider'];
export type SmsProviderChoice = Schemas['SmsProviderChoice'];

// ---- The school record carries the messaging knobs (§2.2, §6.1) ----

export type { SchoolDto, UpdateSchoolBody } from './platform-contract';

// ---- Platform settings (§6.2) ----

export type PlatformSettingsDto = Schemas['PlatformSettingsDto'];
export type UpdatePlatformSettingsBody = Schemas['UpdatePlatformSettingsDto'];

// ---- Delivery health (§2.2, §6.3) ----

export type HealthChannel = Schemas['HealthChannel'];
export type ChannelDayCounts = Schemas['HealthDayChannelDto'];
export type PlatformDeliveryHealthDto = Schemas['PlatformDeliveryHealthDto'];
export type DeliveryHealthWhatsAppFilter = Schemas['WhatsAppHealthFilter'];
export type DeliveryHealthSort = Schemas['DeliveryHealthSort'];
export type DeliveryHealthQuery = NonNullable<
  operations['DeliveryHealthController_health']['parameters']['query']
>;
