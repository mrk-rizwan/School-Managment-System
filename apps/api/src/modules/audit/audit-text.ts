import type { AuditJsonValue } from '../../repositories/audit-reads.repository';

// The audit screen's text rendering (contracts/slice-46.md §2.3, R354): metadata becomes key/value
// text and nothing shaped like an identity number, a phone number or an email address is shown.
// audit_log's CHECKs already refuse a run of 13 digits; this is the screen's own layer, which also
// catches a separated CNIC, a phone number and an email.

/** A key naming a sensitive value: its whole value is hidden, whatever its shape. */
const SENSITIVE_KEY = /cnic|b_?form|identity|national_?id|phone|mobile|msisdn|whatsapp|e_?mail/i;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g;
/** A run of digits that may carry single spaces or dashes between groups, and a leading `+`. */
const DIGIT_RUN = /\+?\d(?:[ -]?\d)*/g;
/** Ten or more digits is a phone or an identity number, never an id, an amount or a date. */
const MIN_MASKED_DIGITS = 10;

const HIDDEN = '***';

/** `text` with every identity-, phone- and email-shaped part masked. */
export function maskText(text: string): string {
  return text
    .replace(EMAIL, (email) => `${email.slice(0, 1)}***${email.slice(email.lastIndexOf('@'))}`)
    .replace(DIGIT_RUN, (run) => {
      const digits = run.replace(/\D/g, '');
      return digits.length >= MIN_MASKED_DIGITS ? `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}` : run;
    });
}

function valueText(value: AuditJsonValue): string {
  if (value === null) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The metadata object as sorted key/value text: nested objects flattened with `.`, arrays and
 * other shapes stringified, every value masked; a sensitive key's value hidden outright.
 */
export function metadataDetails(metadata: AuditJsonValue): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const visit = (prefix: string, value: AuditJsonValue, sensitive: boolean): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value)) {
        if (inner === undefined) continue;
        visit(prefix === '' ? key : `${prefix}.${key}`, inner, sensitive || SENSITIVE_KEY.test(key));
      }
      return;
    }
    const text = valueText(value);
    out.push({ key: prefix, value: sensitive && value !== null && text !== '' ? HIDDEN : maskText(text) });
  };
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) visit('', metadata, false);
  else if (metadata !== null) out.push({ key: 'value', value: maskText(valueText(metadata)) });
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
