/**
 * A metadata value of audit_log and platform_audit_log: JSON without arrays. Ids and timestamps go
 * in as strings (the tables' CHECKs refuse any run of 13 digits, so epoch milliseconds and identity
 * numbers cannot land here). Its own file so a tenant repository need not import a platform one.
 */
export type AuditMetadataValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: AuditMetadataValue };
