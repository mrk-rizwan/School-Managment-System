/**
 * Phone numbers are stored as E.164 (CLAUDE.md conventions; contracts/slice-2.md §2).
 * Pakistani local forms are converted; anything that cannot become valid E.164 is null.
 */
export const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export function normalisePhone(input: string): string | null {
  let value = input.replace(/[\s\-()]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  else if (/^03[0-9]{9}$/.test(value)) value = `+92${value.slice(1)}`;
  else if (/^3[0-9]{9}$/.test(value)) value = `+92${value}`;
  else if (/^92[0-9]{10}$/.test(value)) value = `+${value}`;
  return E164_PATTERN.test(value) ? value : null;
}
