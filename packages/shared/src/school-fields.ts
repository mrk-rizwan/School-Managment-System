/** Rules for the school record shared by the API DTOs and the web forms (contracts/slice-1.md §4). */
export const SHORT_CODE_PATTERN = /^[a-z0-9]{3,12}$/;
export const DEFAULT_TIMEZONE = 'Asia/Karachi';
export const DEFAULT_FEE_DUE_DAY = 10;
export const MIN_FEE_DUE_DAY = 1;
export const MAX_FEE_DUE_DAY = 28;
